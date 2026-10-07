#!/usr/bin/env bun
// worktree.ts — per-item git worktrees (W52). Parallel lanes on one repo get
// an isolated tree each: `.worktrees/<id>` on branch `suspenders/<id>`, with
// gitignored build dirs symlinked in. Claim scope still governs edits (the
// worktree lives inside the project); `work done` retires a clean worktree and
// refuses to destroy a dirty one or a clean-but-live one (work is never
// silently discarded — the branch survives either way for the integration
// spine).
//
//   bun worktree.ts create <id>               # item must be CLAIMED/RUNNING
//   bun worktree.ts retire <id> [--force]     # clean+idle → remove; dirty → keep (exit 3);
//                                             # clean but live lane inside → keep (exit 4)
//   bun worktree.ts path <id>                 # print the worktree path
//
// The path is DERIVED (no schema change): .worktrees/<id> existing = the item
// has a worktree. `work done` calls retire automatically.

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { openGovernorDb, resolveProject } from "../lib/govdb.ts";
import { symlinkBuildDirs } from "../lib/builddirs.ts";
import { laneSid } from "../lib/laneslug.ts";
import { worktreeLive } from "../lib/lane-liveness.ts";
import { retireLaneKey } from "../../scripts/lib/lane-auth.ts";

const [cmd, id, ...flags] = process.argv.slice(2);
const FORCE = flags.includes("--force");

if (!cmd || !id) {
	console.log("usage: worktree.ts {create|retire|path} <id> [--force]");
	process.exit(2);
}

// W459.1: the graph key and the local checkout root resolve together —
// .worktrees lives at the checkout root even when run inside a worktree
const RP = resolveProject();
const PROJECT = RP.id;
const ROOT = RP.root;
const wtDir = join(ROOT, ".worktrees", id);
const branch = `suspenders/${id}`;

// Retiring a migrated item must still revoke the key of its recorded lane.
async function retireItemKey() {
	const sids = new Set([laneSid(id, PROJECT), laneSid(id)]);
	try {
		const rows = JSON.parse(
			readFileSync(join(ROOT, ".fleet/lanes.json"), "utf8"),
		) as { item: string; sid: string }[];
		for (const row of rows) if (row.item === id) sids.add(row.sid);
	} catch {}
	let result: Awaited<ReturnType<typeof retireLaneKey>> | undefined;
	for (const sid of sids) {
		const current = await retireLaneKey({ fleet: join(ROOT, ".fleet"), sid });
		if (!result || current.keyId) result = current;
	}
	return result as Awaited<ReturnType<typeof retireLaneKey>>;
}

const git = (args: string[], cwd = ROOT): { out: string; code: number } => {
	const p = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString().trim(), code: p.exitCode };
};

const die = (msg: string, code = 1): never => {
	console.error(`worktree: ${msg}`);
	process.exit(code);
};

const emit = (kind: string, extra: Record<string, string>): void => {
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, ?, ?, scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
			)
			.run(
				Date.now(),
				"worktree",
				kind,
				JSON.stringify({ work: id, project: PROJECT, ...extra }),
				PROJECT,
				id,
			);
	} catch {
		// bus unavailable (offline mirror fallback) — worktree still works
	}
};

// ─── create ───
if (cmd === "create") {
	const db = openGovernorDb();
	const it = db
		.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
		.get(PROJECT, id) as { state: string } | null;
	if (!it) die(`no work item ${id} in ${PROJECT}`);
	if (!["CLAIMED", "RUNNING"].includes(it.state))
		die(
			`${id} is ${it.state} — a worktree follows a live claim (work take first)`,
		);
	if (existsSync(wtDir)) die(`${wtDir} already exists — retire it first`);

	// keep the isolation dir itself out of every checkout
	const giPath = join(ROOT, ".gitignore");
	if (
		!existsSync(giPath) ||
		!readFileSync(giPath, "utf8")
			.split("\n")
			.some((l) => l.trim() === ".worktrees/")
	) {
		appendFileSync(giPath, "\n.worktrees/\n");
	}

	const r = git(["worktree", "add", "-b", branch, wtDir]);
	if (r.code !== 0) die(`git worktree add failed: ${r.out || "(stderr)"}`);

	// symlink canonical gitignored build dirs so lanes skip reinstalls
	symlinkBuildDirs(ROOT, wtDir);

	emit("work.tree", id, { path: wtDir, branch });
	console.log(`${wtDir}`);
	process.exit(0);
}

// ─── retire ───
if (cmd === "retire") {
	// W463 lane-key lifecycle: a lane over is a key revoked. The dirty guard
	// below keeps a POSSIBLY-LIVE lane's key (exit 3 = the lane may still be
	// running); exit 4 (the W123 liveness guard below) keeps it too — the
	// clean exits retire it and delete the per-lane files.
	if (!existsSync(wtDir) || !existsSync(join(wtDir, ".git"))) {
		console.log(`no worktree for ${id}`);
		const rk = await retireItemKey();
		if (rk.keyId)
			console.log(
				`lane key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke failed — 24h TTL bounds it"}`,
			);
		process.exit(0);
	}
	const dirty = git(["status", "--porcelain"], wtDir).out;
	if (dirty && !FORCE) {
		console.error(
			`${wtDir} is dirty — keeping it (work is never silently discarded; --force to override)`,
		);
		process.exit(3);
	}
	// W123 liveness guard (integrated W395 from parked/W123): a CLEAN tree can
	// still have a live lane inside — yanking its cwd kills the lane mid-flight
	// (gaps 2026-09-30). Any live harness process with cwd in the worktree
	// keeps it; --force overrides, like dirty. Exit 4 = clean-but-live; dirty
	// stays exit 3.
	if (!dirty && !FORCE && worktreeLive(wtDir)) {
		emit("work.tree", id, { kept: "live-lane", path: wtDir, branch });
		console.error(
			`${wtDir} has a live lane inside — keeping it (liveness guard; --force to override)`,
		);
		process.exit(4);
	}
	const r = git(["worktree", "remove", ...(dirty ? ["--force"] : []), wtDir]);
	if (r.code !== 0) die(`git worktree remove failed: ${r.out}`);
	// W463: terminal lane state — revoke the key, delete the per-lane files
	// (0600 key meta + the settings file); the key id rides the event for audit.
	const rk = await retireItemKey();
	const payload: Record<string, string> = { retired: "1", path: wtDir, branch };
	if (rk.keyId) {
		payload.lane_key_id = rk.keyId;
		payload.lane_key_revoked = rk.revoked ? "1" : "0";
	}
	// the branch suspenders/<id> survives — integration merges from refs
	emit("work.tree", id, payload);
	console.log(
		`retired ${wtDir} — branch ${branch} kept for integration${rk.keyId ? ` — lane key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke FAILED — 24h TTL bounds it"}` : ""}`,
	);
	process.exit(0);
}

// ─── path ───
if (cmd === "path") {
	console.log(wtDir);
	process.exit(0);
}

die(`unknown command ${cmd}`, 2);
