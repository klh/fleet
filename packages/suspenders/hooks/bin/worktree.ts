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
//   bun worktree.ts sweep [--main <b>] [--dry-run]  # W494.2.2 supported sweep:
//                                             # patch-id cherry vs main; dirty/
//                                             # live/claimed/young kept; unmerged
//                                             # trees stay with a NEED_DECISION
//
// The path is DERIVED (no schema change): .worktrees/<id> existing = the item
// has a worktree. `work done` calls retire automatically.

import { existsSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openGovernorDb, resolveProject } from "../lib/govdb.ts";
import { symlinkBuildDirs } from "../lib/builddirs.ts";
import { laneSid } from "../lib/laneslug.ts";
import { worktreeLive } from "../lib/lane-liveness.ts";
import { registryWorktrees, resolveItemWorktree } from "../lib/worktree-lookup.ts";
import { retireLaneKey } from "../../scripts/lib/lane-auth.ts";

const [cmd, id, ...flags] = process.argv.slice(2);
const FORCE = flags.includes("--force");

if (!cmd || (!id && cmd !== "sweep")) {
	console.log("usage: worktree.ts {create|retire|path} <id> [--force]");
	console.log("       worktree.ts sweep [--main <branch>] [--dry-run]");
	process.exit(2);
}

// W459.1: the graph key and the local checkout root resolve together —
// .worktrees lives at the checkout root even when run inside a worktree
const RP = resolveProject();
const PROJECT = RP.id;
const ROOT = RP.root;
// W211: resolve the item's tree from git's registry by branch, falling back
// to the conventional .worktrees/<id> — never derive-and-pray
const wtDir = id ? resolveItemWorktree(ROOT, id) : null;
const branch = id ? `suspenders/${id}` : "";

// Retiring a migrated item must still revoke the key of its retire/sweep path.
async function retireItemKey(id: string) {
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

const git = (
	args: string[],
	cwd = ROOT,
): { out: string; code: number; err: string } => {
	const p = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString().trim(),
		err: p.stderr.toString().trim(),
		code: p.exitCode,
	};
};

const die = (msg: string, code = 1): never => {
	console.error(`worktree: ${msg}`);
	process.exit(code);
};

const emit = (
	wid: string,
	kind: string,
	extra: Record<string, string>,
): void => {
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'worktree', ?, ?, ?, NULL)",
			)
			.run(
				Date.now(),
				kind,
				wid,
				JSON.stringify({ work: wid, project: PROJECT, ...extra }),
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
	if (wtDir)
		die(
			`${wtDir} already exists — retire it first (W211: registry-resolved, any path)`,
		);

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

	// W211: a new tree always plants at the conventional .worktrees/<id> —
	// resolution is registry-first, planting stays conventional
	const target = join(ROOT, ".worktrees", id);
	const r = git(["worktree", "add", "-b", branch, target]);
	if (r.code !== 0) die(`git worktree add failed: ${r.out || "(stderr)"}`);

	// symlink canonical gitignored build dirs so lanes skip reinstalls
	symlinkBuildDirs(ROOT, target);

	emit(id, "work.tree", { path: target, branch });
	console.log(`${target}`);
	process.exit(0);
}

// ─── retire ───
if (cmd === "retire") {
	// W463 lane-key lifecycle: a lane over is a key revoked. The dirty guard
	// below keeps a POSSIBLY-LIVE lane's key (exit 3 = the lane may still be
	// running); exit 4 (the W123 liveness guard below) keeps it too — the
	// clean exits retire it and delete the per-lane files.
	if (!wtDir || !existsSync(join(wtDir, ".git"))) {
		console.log(`no worktree for ${id}`);
		const rk = await retireItemKey(id);
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
		emit(id, "work.tree", { kept: "live-lane", path: wtDir, branch });
		console.error(
			`${wtDir} has a live lane inside — keeping it (liveness guard; --force to override)`,
		);
		process.exit(4);
	}
	const r = git(["worktree", "remove", ...(dirty ? ["--force"] : []), wtDir]);
	if (r.code !== 0) die(`git worktree remove failed: ${r.out}`);
	// W463: terminal lane state — revoke the key, delete the per-lane files
	// (0600 key meta + the settings file); the key id rides the event for audit.
	const rk = await retireItemKey(id);
	const payload: Record<string, string> = { retired: "1", path: wtDir, branch };
	if (rk.keyId) {
		payload.lane_key_id = rk.keyId;
		payload.lane_key_revoked = rk.revoked ? "1" : "0";
	}
	// the branch suspenders/<id> survives — integration merges from refs
	emit(id, "work.tree", payload);
	console.log(
		`retired ${wtDir} — branch ${branch} kept for integration${rk.keyId ? ` — lane key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke FAILED — 24h TTL bounds it"}` : ""}`,
	);
	process.exit(0);
}

// ─── path ───
if (cmd === "path") {
	console.log(wtDir ?? join(ROOT, ".worktrees", id));
	process.exit(0);
}

// ─── sweep ───
// W494.2.2: the supported sweep. 2026-10-06: 14 worktrees of DONE items
// stood after a crash skipped their retire — 8 ghost lanes filled the
// dispatch pool and fleet-loop dispatched nothing for hours. The merge test
// is PATCH-ID cherry vs the main branch, never ancestry (amend-era rewrites
// make ancestry lie — a non-ancestor branch can be fully EQUIV). Guards keep
// anything that can still be work: dirty → live lane → live claim → young
// (mid-spawn grace), then the merge verdict. Unmerged trees stay with a
// NEED_DECISION; swept branches pin a refs/recover/* tip before removal.
// --dry-run previews the verdicts without writing anything.
if (cmd === "sweep") {
	// args, counters, the graph handle
	const mi = flags.indexOf("--main");
	const MAIN = mi >= 0 ? (flags[mi + 1] ?? "main") : "main";
	const DRY = flags.includes("--dry-run");
	const GRACE = Number(process.env.WORKTREE_SWEEP_GRACE_MS ?? 600_000);
	const kept = (wid: string, reason: string): void => {
		console.log(`KEPT ${wid} — ${reason}`);
	};
	let swept = 0;
	let unmerged = 0;
	let considered = 0;
	let would = 0;
	const db = openGovernorDb();
	// porcelain is ground truth — registryWorktrees, the W211 lib (one parser)
	const entries = registryWorktrees(ROOT);
	for (const e of entries) {
		if (e.path === ROOT) continue; // the main checkout itself
		// W600: the item id resolves from the BRANCH (suspenders/<id>), never
		// the basename — codex-parked trees and .fleet/reviews slugs share the
		// basename 'fleet'; no item 'fleet' exists, so a basename id bypassed
		// the claim guard and cherry/NEED_DECISION-verdicted foreign trees.
		// Anything not on suspenders/<id> is not ours to judge: kept, always.
		const wid = e.branch?.startsWith("suspenders/")
			? e.branch.slice("suspenders/".length)
			: null;
		if (!wid || !e.branch) {
			kept(
				e.path,
				e.branch
					? `not a fleet item tree (branch ${e.branch})`
					: "detached HEAD — not a fleet item tree",
			);
			considered++;
			continue;
		}
		// loop-local: the module-level `branch` is suspenders/<argv-id> — for
		// sweep there IS no id, so it must never leak into this verdict
		const br = e.branch;
		const dirty = git(["status", "--porcelain"], e.path).out;
		if (dirty !== "") {
			// name the first dirt line — a sweep that says only "dirty" sends
			// the operator spelunking; the evidence belongs in the verdict
			kept(
				wid,
				`dirty — work is never silently discarded (${(dirty.split("\n")[0] ?? "").slice(0, 60)})`,
			);
			considered++;
			continue;
		}
		if (worktreeLive(e.path)) {
			kept(wid, "live lane inside — liveness guard");
			considered++;
			continue;
		}
		const it = db
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(PROJECT, wid) as { state: string } | null;
		if (it && ["CLAIMED", "RUNNING"].includes(it.state)) {
			kept(wid, `claim live (${it.state})`);
			considered++;
			continue;
		}
		// mid-spawn grace: a seconds-old tree is the pre-spawn window, not
		// debris (gaps 2026-09-28 doctrine) — WORKTREE_SWEEP_GRACE_MS=0 ages
		// everything for tests and scripted cleanup
		try {
			if (Date.now() - statSync(e.path).birthtimeMs < GRACE) {
				kept(wid, "young — mid-spawn grace");
				considered++;
				continue;
			}
		} catch {}
		// merge verdict: PATCH-ID cherry vs MAIN. "-" = an equivalent patch
		// landed in MAIN; "+" = nothing matches. A FAILED cherry reads
		// unmerged, never merged (gaps 2026-09-28: failed probes read UNMERGED)
		const ch = git(["cherry", MAIN, br]);
		const lines = ch.code === 0 ? ch.out.split("\n").filter(Boolean) : ["+"];
		const plus = lines.filter((l) => l.startsWith("+"));
		if (plus.length > 0) {
			unmerged++;
			kept(
				wid,
				`${plus.length} patch(es) not in ${MAIN} — NEED_DECISION emitted [${ch.err || `cherry exit ${ch.code}`}]`,
			);
			if (!DRY)
				emit(wid, "NEED_DECISION", {
					branch: br,
					ahead: String(plus.length),
					note: `worktree ${e.path} holds ${plus.length} commit(s) with no patch-id equivalent in ${MAIN} — keep for inspection or force-delete?`,
				});
			continue;
		}
		const equiv = lines.length > 0; // all "-": non-ancestor but fully EQUIV
		if (DRY) {
			would++;
			console.log(
				`WOULD-SWEPT ${wid} — ${equiv ? "patch-equiv" : "ancestry-merged"}`,
			);
			continue;
		}
		// REFERENCE BEFORE DELETE (gaps 2026-09-28): pin the tip before any
		// destructive step so no -D can orphan the commits
		const tip = git(["rev-parse", "--verify", br]).out;
		if (tip)
			git([
				"update-ref",
				`refs/recover/${br.replace(/\//g, "-")}-${Date.now()}`,
				tip,
			]);
		let rm = git(["worktree", "remove", e.path]);
		if (rm.code !== 0) {
			// stale registration outlived a dead lane — prune and retry once
			git(["worktree", "prune"]);
			rm = git(["worktree", "remove", e.path]);
			if (rm.code !== 0) {
				kept(
					wid,
					`worktree remove failed: ${rm.out.split("\n").at(-1) ?? "?"}`,
				);
				considered++;
				continue;
			}
		}
		// -d refuses non-ancestor branches; patch-equivalence just proved the
		// content is in MAIN, so -D is the honest verb there
		const delD = git(["branch", "-d", br]);
		let via: string | null = delD.code === 0 ? "-d" : null;
		if (!via && equiv) via = git(["branch", "-D", br]).code === 0 ? "-D" : null;
		if (!via) {
			kept(wid, `branch delete failed: ${delD.out.split("\n").at(-1) ?? "?"}`);
			considered++;
			continue;
		}
		swept++;
		emit(wid, "work.tree", { swept: "1", path: e.path, branch: br, via });
		const rk = await retireItemKey(wid);
		console.log(
			`SWEPT ${wid} — ${equiv ? "patch-equiv" : "ancestry-merged"} (${via})${rk.keyId ? ` — lane key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke FAILED — 24h TTL bounds it"}` : ""}`,
		);
	}
	console.log(
		`sweep: ${DRY ? "would-sweep" : "swept"}=${DRY ? would : swept} unmerged=${unmerged} kept=${considered}`,
	);
	process.exit(0);
}

die(`unknown command ${cmd}`, 2);
