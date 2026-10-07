// test/dispatch-next.test.ts — W145: suspenders dispatches its own fan-outs
// through the fleet machinery. Covered: the capsule write/read round-trip
// through the REAL coord verb (scratch-HOME governor db), dry-run dispatch
// (prints item + brief, spawns nothing, takes nothing), and resume-rebrief
// composition (dead lane's last capsule returns as RESUME CONTEXT).
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	chmodSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { captureClaimFeed } from "../scripts/lib/structured-feed.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import {
	composeBrief,
	isOwnerGated,
	laneKeyDecision,
	parseCapsuleGet,
	parseGovernanceMode,
	parseReady,
	probeFrontDecision,
} from "../scripts/dispatch-next.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w145-dispatch-home-"));
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "suspenders-w145-dispatch-repo-")));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
// W463: pin the buckle front to a dead port for the legacy cases — probe
// misses = belt-direct note path (pre-W463 behavior), deterministic even on
// a machine with a live spoke on :4101. Fail-closed refusal/override get
// their own stub-front cases below.
const testExecutor = join(HOME, "test-claude");
writeFileSync(testExecutor, "#!/bin/sh\nexit 0\n");
chmodSync(testExecutor, 0o700);
const env = {
	SUSPENDERS_CLAUDE_BIN: testExecutor,
	...process.env,
	HOME,
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: one commit so worktree ops would have a base
import { spawnSync } from "node:child_process";
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const toolWith = (
	extra: Record<string, string | undefined>,
	bin: string,
	...args: string[]
) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};
const tool = (bin: string, ...args: string[]) => toolWith({}, bin, ...args);
const dispatchWith = (
	extra: Record<string, string | undefined>,
	...args: string[]
) => {
	// dispatch-next lives in scripts/, not hooks/bin — spawn it directly
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{ cwd: REPO, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};
const dispatch = (...args: string[]) => dispatchWith({}, ...args);

describe("CLI help is read-only", () => {
	test("help flags print usage without creating runtime state or claiming work", () => {
		const id =
			(tool("work.ts", "add", "help must not dispatch fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const before = tool("work.ts", "show", id, "--json").out;
		const stale =
			(tool("work.ts", "add", "help must not resume fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		expect(
			tool(
				"work.ts",
				"take",
				stale,
				"--as",
				"autowhelp",
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", stale, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, stale],
		);
		db.close();
		const staleBefore = tool("work.ts", "show", stale, "--json").out;
		for (const help of ["--help", "-h"]) {
			// Even the buggy path cannot spawn real models in this regression.
			const result = dispatch(help, "--target", "0");
			expect(result.code).toBe(0);
			expect(result.out).toContain("Usage: dispatch");
			expect(result.out).not.toContain("lanes live:");
			expect(existsSync(join(REPO, ".fleet"))).toBe(false);
			expect(tool("work.ts", "show", id, "--json").out).toBe(before);
			expect(tool("work.ts", "show", stale, "--json").out).toBe(staleBefore);
			expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		}
		// This file shares a scratch graph; remove the fixture from later picks.
		expect(tool("work.ts", "fail", id).code).toBe(0);
		expect(tool("work.ts", "fail", stale).code).toBe(0);
	});
});

describe("explicit dispatch ownership scope", () => {
	test("one requested item never recovers unrelated orphan claims", () => {
		const add = (title: string) =>
			tool("work.ts", "add", title).out.match(/W\d+/)?.[0] ?? "";
		const target = add("explicit dispatch target");
		const stale = add("unrelated orphan must stay put");
		expect(
			tool(
				"work.ts",
				"take",
				stale,
				"--as",
				"autowunrelated",
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", stale, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, stale],
		);
		db.close();
		const before = tool("work.ts", "show", stale, "--json").out;
		const result = dispatch(
			"--dry-run",
			"--item",
			target,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`DRY dispatch ${target}`);
		expect(result.out).not.toContain(
			`recovered missing registry identity ${stale}`,
		);
		expect(result.out).not.toContain(`DRY dispatch ${stale}`);
		expect(tool("work.ts", "show", stale, "--json").out).toBe(before);
		const fleet = join(REPO, ".fleet");
		mkdirSync(fleet, { recursive: true });
		writeFileSync(
			join(fleet, "lanes.json"),
			JSON.stringify([
				{
					sid: "autowunrelated",
					item: stale,
					pid: 99999999,
					branch: `suspenders/${stale}`,
					worktree: join(REPO, ".worktrees", stale),
					launchedAt: 1,
					attempt: 0,
				},
			]),
		);
		const registered = dispatch(
			"--dry-run",
			"--item",
			target,
			"--target",
			"1",
			"--no-belt",
		);
		expect(registered.code).toBe(0);
		expect(registered.out).toContain(`DRY dispatch ${target}`);
		expect(registered.out).not.toContain(`DRY dispatch ${stale}`);
		expect(tool("work.ts", "show", stale, "--json").out).toBe(before);
		rmSync(join(fleet, "lanes.json"));

		expect(tool("work.ts", "fail", target).code).toBe(0);
		expect(tool("work.ts", "fail", stale).code).toBe(0);
	});
});

describe("capsule protocol (real coord verb, scratch db)", () => {
	test("write/read round-trip", () => {
		const set = tool(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"autowrt",
			"--checkpoint=deadbeef",
			"--file=src/x.ts:42",
			"--done=parser green",
			"--next=wire the gate",
		);
		expect(set.code).toBe(0);
		const got = tool("coord.ts", "capsule", "get", "--as", "autowrt");
		expect(got.code).toBe(0);
		const cap = parseCapsuleGet(got.out);
		expect(cap).not.toBeNull();
		expect(cap?.checkpoint).toBe("deadbeef");
		expect(cap?.next).toBe("wire the gate");
		// empty read is null, not a crash — the fresh-lane path
		expect(parseCapsuleGet("(no capsule)")).toBeNull();
	});
});

describe("dry-run dispatch", () => {
	let id = "";
	test("relative repo input produces absolute lane brief and worktree paths", () => {
		const added = tool("work.ts", "add", "relative-path dispatch regression");
		const item = added.out.match(/W\d+/)?.[0] ?? "";
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../scripts/dispatch-next.ts"),
				"--repo",
				".",
				"--item",
				item,
				"--dry-run",
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain(`repo ${REPO}`);
		expect(r.stdout.toString()).not.toContain("repo .\n");
		expect(
			tool("work.ts", "take", item, "--as", "relative-repo-test").code,
		).toBe(0);
		expect(
			tool(
				"work.ts",
				"done",
				item,
				"--sha",
				"deadbeef",
				"--as",
				"relative-repo-test",
			).code,
		).toBe(0);
	});
	test("new project lane can be claimed despite legacy session prefix collisions", () => {
		const added = tool("work.ts", "add", "project-qualified claim regression");
		const item = added.out.match(/W\d+/)?.[0] ?? "";
		const legacy = laneSid(item);
		expect(
			tool(
				"coord.ts",
				"bootstrap",
				"--as",
				`${legacy}0`,
				"--name",
				"old lane A",
			).code,
		).toBe(0);
		expect(
			tool(
				"coord.ts",
				"bootstrap",
				"--as",
				`${legacy}1`,
				"--name",
				"old lane B",
			).code,
		).toBe(0);
		expect(tool("work.ts", "take", item, "--as", legacy).err).toContain(
			"ambiguous sid prefix",
		);
		const namespaced = laneSid(item, projectIdentity(REPO));
		expect(tool("work.ts", "take", item, "--as", namespaced).code).toBe(0);
		expect(
			JSON.parse(tool("work.ts", "show", item, "--json").out).owner_sid,
		).toBe(namespaced);
		const baseline = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		writeFileSync(join(REPO, "fixture.ts"), "export const completed = true;\n");
		g(["add", "fixture.ts"]);
		g(["commit", "-m", "verified fixture completion"]);
		const sha = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		const context = join(REPO, ".fleet/lane-context.json");
		writeFileSync(context, JSON.stringify({ sid: namespaced, item, baseline }));
		try {
			expect(
				tool(
					"work.ts",
					"done",
					item,
					"--sha",
					sha,
					"--as",
					namespaced,
					"--summary",
					"Verified lane identity survives legacy prefix collisions; committed a real source change with immutable baseline evidence.",
				).code,
			).toBe(0);
		} finally {
			rmSync(context);
		}
	});
	test("prints chosen item + full brief, takes nothing, spawns nothing", () => {
		const added = tool("work.ts", "add", "sample lane mission");
		id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--target", "1");
		expect(out.out).toContain(`DRY dispatch ${id}`);
		expect(out.out).toContain("CAPSULE PROTOCOL");
		expect(out.out).toContain("LANDING CHAIN");
		expect(out.out).toContain(`lane "${laneSid(id, projectIdentity(REPO))}"`);
		// no side effects: no claim, no worktree, no lane registry
		const show = tool("work.ts", "show", id);
		expect(show.out).toContain("READY");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		expect(existsSync(join(REPO, ".fleet", "lanes.json"))).toBe(false);
	});
});

describe("resume-rebrief composition", () => {
	test("dead lane's capsule returns as RESUME CONTEXT", () => {
		const showOut = "◐ W140 RUNNING  sample item\n  owner_sid: autow140";
		const base = {
			item: "W140",
			showOut,
			sid: "autow140",
			branch: "suspenders/W140",
			worktree: "/tmp/nowhere/.worktrees/W140",
		};
		const fresh = composeBrief({ ...base, capsule: null });
		expect(fresh).not.toContain("RESUME CONTEXT —");
		expect(fresh).toContain("CAPSULE PROTOCOL");
		expect(fresh).toContain("FORMAT: Read the nearest .qlty/qlty.toml");
		expect(fresh).toContain("never manually chase formatter wrapping");
		expect(fresh).toContain(`done W140 --sha <branch-head> --as autow140`);
		expect(fresh).toContain("finding.w140");
		const resumed = composeBrief({
			...base,
			capsule: { checkpoint: "abc123", done: "half", next: "other half" },
		});
		expect(resumed).toContain("RESUME CONTEXT —");
		expect(resumed).toContain("abc123");
	});
});

describe("pool parsing", () => {
	test("parseReady reads renderRow rows; owner-gated titles skip", () => {
		const rows = [
			"\x1b[36m  · W140   build the thing\x1b[0m",
			"  · W141   OWNER-GATED: wait for owner",
			"  ⚠ W142   blocked row (not READY glyph)",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed.map((r) => r.id)).toEqual(["W140", "W141"]);
		expect(parsed[1].title).toContain("OWNER-GATED");
		expect(isOwnerGated(parsed[1].title)).toBe(true);
		expect(isOwnerGated(parsed[0].title)).toBe(false);
	});

	test("parseReady W494: an id that fills the pad emits no separator — still parsed", () => {
		// synthetic: W999999 is 7 chars (pad width) so the renderer's gap
		// vanishes; the id class must stop at the first non-id char.
		const rows = [
			"  · W999999synthetic title glued to the pad edge",
			"  · W12   short id keeps its padded gap",
			"  · W999999",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed.map((r) => r.id)).toEqual(["W999999", "W12", "W999999"]);
		expect(parsed[0].title).toBe("synthetic title glued to the pad edge");
		expect(parsed[1].title).toBe("short id keeps its padded gap");
		expect(parsed[2].title).toBe("");
	});
});

describe("must/prefer chain (owner directive 2026-10-03: sequential, CLI-agnostic)", () => {
	test("multiple must=/prefer= lines: attempt 0 picks the first must, trailing same-bin entries ride --fallback-model", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=sonnet", "prefer=fable", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain sample item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--item", id);
		expect(out.out).toContain("DRY chain attempt 0/2 -> opus");
		expect(out.out).toContain("(+fallback-model sonnet,fable)");
	});

	test("a dead/resumed lane advances to the next chain entry, including across a bin switch", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=copilot", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain resume item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		// attempt 0: opus, no same-bin tail to fall back on (copilot is a
		// different bin — only reachable by the NEXT dispatch, same sid)
		const first = dispatch("--dry-run", "--item", id);
		expect(first.out).toContain("DRY chain attempt 0/1 -> opus");
		expect(first.out).not.toContain("fallback-model");
		rmSync(join(REPO, ".prefer"));
	});
});

describe("crash resume budget", () => {
	test("an old missing-registry claim resumes with its original sid and capsule", () => {
		const id =
			(tool("work.ts", "add", "missing registry fixture").out.match(/W\d+/) ??
				[])[0] ?? "";
		const sid = `autow${id.slice(1)}-legacy`;
		expect(
			tool(
				"work.ts",
				"take",
				id,
				"--as",
				sid,
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		expect(
			tool(
				"coord.ts",
				"capsule",
				"set",
				"--as",
				sid,
				"--next=preserve this checkpoint",
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", id, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, id],
		);
		db.close();
		const registry = join(REPO, ".fleet", "lanes.json");
		expect(
			JSON.parse(tool("work.ts", "orphaned", "--json").out).some(
				(r: { id: string }) => r.id === id,
			),
		).toBe(true);
		const result = dispatch("--dry-run", "--item", id);
		expect(result.out).toContain(`DRY dispatch ${id} → ${sid}`);
		expect(result.out).toContain("preserve this checkpoint");
		expect(existsSync(registry)).toBe(false);
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		expect(tool("work.ts", "fail", id, "--as", sid).code).toBe(0);
	});
	test("automatic failure cannot alter another owner's claim", () => {
		const id =
			(tool("work.ts", "add", "ownership-safe failure fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		expect(tool("work.ts", "take", id, "--as", "current-owner").code).toBe(0);
		expect(tool("work.ts", "fail", id, "--as", "stale-owner").code).not.toBe(0);
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
	});
	test("single-executor crashes persist increasing attempts and stop at the configured cap", async () => {
		const fakeBin = join(HOME, "fake-bin");
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(fakeBin, "claude"), 0o700);
		const id =
			(tool("work.ts", "add", "bounded single-executor fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const extra = {
			PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			SUSPENDERS_LANE_MAX_ATTEMPTS: "2",
		};
		for (const attempt of [0, 1]) {
			const result = dispatchWith(
				{ ...extra, SUSPENDERS_CLAUDE_BIN: join(fakeBin, "claude") },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			);
			expect(result.code).not.toBe(0);
			expect(result.out).toContain("executor exited during launch");
			expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
				"READY",
			);
			expect(
				tool(
					"coord.ts",
					"fact",
					"get",
					`lane.${laneSid(id, projectIdentity(REPO))}.launch-attempt`,
				).out,
			).toContain(String(attempt));
		}
		expect(dispatchWith(extra, "--item", id).out).toContain(
			"launch budget exhausted",
		);
		expect(dispatchWith(extra, "--item", id).out).not.toContain("(pid");
	}, 60_000);

	test("exhausted dead claim is preserved on preview and failed before another launch", () => {
		const added = tool("work.ts", "add", "exhausted resume fixture");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		const sid = `autow${id.slice(1)}`;
		expect(tool("work.ts", "take", id, "--as", sid).code).toBe(0);
		const fleet = join(REPO, ".fleet");
		mkdirSync(fleet, { recursive: true });
		writeFileSync(
			join(fleet, "lanes.json"),
			JSON.stringify([
				{
					sid,
					item: id,
					pid: 99999999,
					branch: `suspenders/${id}`,
					worktree: join(REPO, ".worktrees", id),
					launchedAt: 1,
					attempt: 2,
				},
			]),
		);
		const preview = dispatch("--dry-run", "--item", id);
		expect(preview.out).toContain("resume budget exhausted");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		const result = dispatch("--item", id);
		expect(result.out).toContain("resume budget exhausted");
		expect(result.out).not.toContain("REFUSED");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"FAILED"',
		);
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		rmSync(join(fleet, "lanes.json"));
	}, 60_000);
});
// ─── W463 fail-closed governance + lane key lifecycle ──────────────────────
// NOTE: e2e cases here spawn dispatch-next/worktree async (Bun.spawn, not
// spawnSync): a sync spawn blocks this process' event loop, which would stall
// the stub buckle front and make the child's 600ms front probe time out.

const stubBuckle = (
	mint = false,
): {
	port: number;
	calls: string[];
	stop: () => void;
} => {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			calls.push(`${req.method} ${path}`);
			if (path === "/status") return new Response("ok");
			if (path === "/v1/admin/keys" && mint)
				return Response.json({ key: "bksk_fixture_only", key_id: "owned-key" });
			if (path === "/v1/admin/keys")
				return new Response(JSON.stringify({ error: "stub-mint-fail" }), {
					status: 500,
				});
			if (path.endsWith("/revoke"))
				return new Response(JSON.stringify({ revoked: "ok" }));
			return new Response("not found", { status: 404 });
		},
	});
	return { port: server.port, calls, stop: () => server.stop(true) };
};

// scratch belt.env with an admin key — the mint CALL fails at the stub, which
// is the W463 defect scenario (front up, governance mint broken)
writeFileSync(join(HOME, "belt.env"), "BUCKLE_ADMIN_KEY=bksk_admin_scratch\n");

const toolA = async (
	extra: Record<string, string | undefined>,
	bin: string,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const p = Bun.spawn([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

const dispatchA = async (
	extra: Record<string, string | undefined>,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const cmd = [
		process.execPath,
		join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
		"--repo",
		REPO,
		...args,
	];
	const p = Bun.spawn(cmd, {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

const addItem = async (title: string): Promise<string> => {
	const added = await toolA({}, "work.ts", "add", title);
	const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};
describe("fail-closed governance (W463)", () => {
	test("laneKeyDecision: mint ok → governed", () => {
		const d = laneKeyDecision({ key: "bksk_x", keyId: "abc123def45" }, false);
		expect(d.mode).toBe("governed");
		if (d.mode === "governed") {
			expect(d.key).toBe("bksk_x");
			expect(d.keyId).toBe("abc123def45");
		}
	}, 30_000);

	test("laneKeyDecision: mint fail + no flag → refuse mentioning BUCKLE_ADMIN_KEY", () => {
		const d = laneKeyDecision(null, false);
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") expect(d.why).toContain("BUCKLE_ADMIN_KEY");
	}, 30_000);

	test("laneKeyDecision: mint fail + --allow-ungoverned → loud override", () => {
		const d = laneKeyDecision(null, true);
		expect(d.mode).toBe("ungoverned-override");
		if (d.mode === "ungoverned-override")
			expect(d.note).toContain("UNGOVERNED DISPATCH");
	}, 30_000);

	test("mint failure refuses the dispatch (fail-closed), claim reclaimed, exit non-zero", async () => {
		const stub = stubBuckle();
		const id = await addItem("fail-closed governance item");
		const out = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				// spawn-safety: even on regression, no real lane can spawn
				PATH: "/usr/bin:/bin",
			},
			"--item",
			id,
		);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain(`REFUSED ${id}`);
		expect(out.out).toContain("BUCKLE_ADMIN_KEY");
		// nothing spawned, claim reclaimed → READY
		expect(out.out).not.toContain("(pid");
		const show = await toolA({}, "work.ts", "show", id);
		expect(show.out).toContain("READY");
		stub.stop();
	}, 60_000);

	test("--allow-ungoverned discloses bypass but rejects an immediately exiting executor", async () => {
		const stub = stubBuckle();
		const id = await addItem("ungoverned override e2e item");
		const sid = laneSid(id, projectIdentity(REPO));
		const out = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				// claude lives in ~/.local/bin — stripped PATH = executor skip
				// right after the governance block, so no real lane spawns
				PATH: "/usr/bin:/bin",
			},
			"--item",
			id,
			"--allow-ungoverned",
		);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain("UNGOVERNED DISPATCH — operator override");
		expect(out.out).toContain("executor exited during launch");
		expect(out.out).not.toContain("(pid");
		const brief = readFileSync(join(REPO, ".fleet", `brief-${sid}.md`), "utf8");
		expect(brief).toContain("UNGOVERNED DISPATCH — operator override");
		const wtBrief = readFileSync(
			join(REPO, ".worktrees", id, ".klh-brief.md"),
			"utf8",
		);
		expect(wtBrief).toContain("GOVERNANCE: UNGOVERNED DISPATCH");
		stub.stop();
	}, 60_000);
});

test("executor unavailable rejects before claim, worktree or key mint", async () => {
	const stub = stubBuckle(true);
	try {
		const id = await addItem("missing executor preclaim fixture");
		const result = await dispatchA(
			{
				SUSPENDERS_CLAUDE_BIN: join(HOME, "does-not-exist"),
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("nothing claimed or minted");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		expect(stub.calls).toEqual([]);
	} finally {
		stub.stop();
	}
}, 60_000);

test("early failed launch releases claim, revokes only its key, preserves baseline and worktree", async () => {
	const stub = stubBuckle(true);
	try {
		const id = await addItem("failed executor owned-key fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		const result = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("executor exited during launch");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(stub.calls.filter((c) => c.endsWith("/revoke"))).toEqual([
			"POST /v1/admin/keys/owned-key/revoke",
		]);
		expect(existsSync(join(REPO, ".fleet", `lane-settings-${sid}.json`))).toBe(
			false,
		);
		expect(existsSync(join(REPO, ".fleet", `lane-key-${sid}.json`))).toBe(
			false,
		);
		expect(
			existsSync(join(REPO, ".worktrees", id, ".fleet/lane-context.json")),
		).toBe(true);
	} finally {
		stub.stop();
	}
}, 60_000);

test("registry persistence failure kills its launched child and cleans its own claim and key", async () => {
	const stub = stubBuckle(true);
	const registry = join(REPO, ".fleet/lanes.json");
	const pidFile = join(HOME, "registry-failure.pid");
	const executor = join(HOME, "registry-failure-executor");
	writeFileSync(
		executor,
		`#!/bin/sh\necho $$ > "${pidFile}"\nmkdir "${registry}"\nexec /bin/sleep 30\n`,
	);
	chmodSync(executor, 0o700);
	rmSync(registry, { recursive: true, force: true });
	try {
		const id = await addItem("registry persistence failure fixture");
		const result = await dispatchA(
			{
				SUSPENDERS_CLAUDE_BIN: executor,
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("launch failed");
		expect(result.out).not.toContain("dispatched ");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(stub.calls.filter((c) => c.endsWith("/revoke"))).toEqual([
			"POST /v1/admin/keys/owned-key/revoke",
		]);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		rmSync(registry, { recursive: true, force: true });
		stub.stop();
	}
}, 60_000);

test("simultaneous dispatchers launch one harness and loser preserves winner", async () => {
	const pidFile = join(HOME, "overlap-pids");
	const executor = join(HOME, "overlap-executor");
	writeFileSync(
		executor,
		`#!/bin/sh\necho $$ >> "${pidFile}"\nexec /bin/sleep 30\n`,
	);
	chmodSync(executor, 0o700);
	const id = await addItem("overlapping dispatch fixture");
	try {
		const results = await Promise.all([
			dispatchA(
				{ SUSPENDERS_CLAUDE_BIN: executor },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			),
			dispatchA(
				{ SUSPENDERS_CLAUDE_BIN: executor },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			),
		]);
		expect(results.filter((r) => r.out.includes("dispatched "))).toHaveLength(
			1,
		);
		expect(results.filter((r) => !r.out.includes("dispatched ")).length).toBe(
			1,
		);
		expect(readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("CLAIMED");
	} finally {
		if (existsSync(pidFile))
			for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
				try {
					process.kill(Number(pid));
				} catch {}
			}
	}
}, 60_000);

test("stale prelease snapshot rereads published live lane after winner releases lease", async () => {
	const id = await addItem("stale dispatcher snapshot fixture");
	const registry = join(REPO, ".fleet/lanes.json");
	rmSync(registry, { force: true });
	const block = join(HOME, "snapshot-block");
	const unblock = join(HOME, "snapshot-release");
	const pidFile = join(HOME, "stale-snapshot-pids");
	const executorDir = join(HOME, "stale-harness");
	mkdirSync(executorDir, { recursive: true });
	const executor = join(executorDir, "claude");
	writeFileSync(
		executor,
		`#!${process.execPath}\nimport {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(pidFile)},String(process.pid)+"\\n");setInterval(()=>{},1000);\n`,
	);
	chmodSync(executor, 0o700);
	const prefix = join(HOME, "stale-prefix");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	for (const name of ["coord.ts", "worktree.ts"])
		symlinkSync(join(BIN, name), join(prefix, "bin", name));
	writeFileSync(
		join(prefix, "bin/work.ts"),
		`import {existsSync,writeFileSync} from "node:fs"; if(process.argv[2]==="lanes"){writeFileSync(${JSON.stringify(block)},"blocked");while(!existsSync(${JSON.stringify(unblock)}))await Bun.sleep(10);console.log("[]");}else{const p=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},...process.argv.slice(2)],{stdout:"pipe",stderr:"pipe"});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.exitCode);}
`,
	);
	const stale = dispatchA(
		{ SUSPENDERS_PREFIX: prefix, SUSPENDERS_CLAUDE_BIN: executor },
		"--item",
		id,
		"--no-belt",
		"--allow-ungoverned",
	);
	try {
		for (let n = 0; !existsSync(block) && n < 500; n++) await Bun.sleep(10);
		expect(existsSync(block)).toBe(true);
		const winner = await dispatchA(
			{ SUSPENDERS_CLAUDE_BIN: executor },
			"--item",
			id,
			"--no-belt",
			"--allow-ungoverned",
		);
		expect(winner.out).toContain("dispatched ");
		writeFileSync(unblock, "release");
		const loser = await stale;
		expect(loser.out).toContain(
			"durable registry already holds a live or unknown lane",
		);
		expect(readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("CLAIMED");
	} finally {
		writeFileSync(unblock, "release");
		await stale;
		if (existsSync(pidFile))
			for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
				try {
					process.kill(Number(pid));
				} catch {}
			}
		rmSync(registry, { force: true });
	}
}, 60_000);

test("custom installed prefix resolves work and coord helpers", () => {
	const prefix = join(HOME, "custom-prefix");
	mkdirSync(prefix, { recursive: true });
	symlinkSync(BIN, join(prefix, "bin"), "dir");
	const id =
		(tool("work.ts", "add", "custom prefix fixture").out.match(/W\d+/) ??
			[])[0] ?? "";
	const result = dispatchWith(
		{ SUSPENDERS_PREFIX: prefix },
		"--item",
		id,
		"--dry-run",
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain(`bun ${prefix}/bin/coord.ts`);
});

describe("lane key lifecycle (W463)", () => {
	test.each([false, true])(
		"worktree retire revokes legacy or project-qualified lane keys (%s)",
		async (qualified) => {
			const stub = stubBuckle();
			const id = await addItem("lane key lifecycle item");
			const sid = laneSid(id, qualified ? projectIdentity(REPO) : undefined);
			expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(
				0,
			);
			expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
			mkdirSync(join(REPO, ".fleet"), { recursive: true });
			const metaPath = join(REPO, ".fleet", `lane-key-${sid}.json`);
			const settingsPath = join(REPO, ".fleet", `lane-settings-${sid}.json`);
			writeFileSync(
				metaPath,
				JSON.stringify({ sid, key_id: "deadbeefcafe", mintedAt: 1 }),
			);
			writeFileSync(settingsPath, "{}");
			const out = await toolA(
				{
					SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
					SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				},
				"worktree.ts",
				"retire",
				id,
			);
			expect(out.code).toBe(0);
			expect(out.out).toContain("deadbeefcafe");
			expect(
				stub.calls.some((c) =>
					c.includes("/v1/admin/keys/deadbeefcafe/revoke"),
				),
			).toBe(true);
			expect(existsSync(metaPath)).toBe(false);
			expect(existsSync(settingsPath)).toBe(false);
			stub.stop();
		},
		60_000,
	);
});

// ─── governance mode (W422.17, owner ruling 2026-10-06) ──────────────────
describe("governance mode decisions (W422.17)", () => {
	test("probeFrontDecision: strict refuses, citing front + governance:strict", () => {
		const d = probeFrontDecision(false, "strict");
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse")
			expect(d.why).toContain("buckle front unreachable + governance:strict");
	});

	test("probeFrontDecision: solo proceeds belt-direct with the loud note", () => {
		const d = probeFrontDecision(false, "solo");
		expect(d.mode).toBe("belt-direct");
		if (d.mode === "belt-direct") expect(d.note).toContain("governance:solo");
	});

	test("probeFrontDecision: --allow-ungoverned overrides BOTH modes", () => {
		for (const m of ["strict", "solo"] as const) {
			expect(probeFrontDecision(true, m).mode).toBe("ungoverned-override");
		}
	});

	test("parseGovernanceMode: unset/strict/garbage → strict; solo → solo", () => {
		expect(parseGovernanceMode("(unset)")).toBe("strict");
		expect(parseGovernanceMode("solo (v3)")).toBe("solo");
		expect(parseGovernanceMode("strict (v1)")).toBe("strict");
		expect(parseGovernanceMode("wibble (v9)")).toBe("strict");
	});

	test("laneKeyDecision: solo does NOT relent at mint failures (W463 stands)", () => {
		expect(laneKeyDecision(null, false, "solo").mode).toBe("refuse");
	});
});

describe("governance mode e2e: probe-false strict (W422.17)", () => {
	test("fact absent → strict applies: REFUSED, claim reclaimed, exit non-zero", async () => {
		const id = await addItem("governance strict refusal item");
		const out = await dispatchA({ PATH: "/usr/bin:/bin" }, "--item", id);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain(`REFUSED ${id}`);
		expect(out.out).toContain("buckle front unreachable + governance:strict");
		expect(out.out).toContain("dispatch(es) REFUSED");
		expect(out.out).not.toContain("(pid");
		const show = await toolA({}, "work.ts", "show", id);
		expect(show.out).toContain("READY");
	}, 60_000);
});

describe("governance mode e2e: probe-false solo (W422.17)", () => {
	test("probe-false + solo → proceeds belt-direct with the loud note", async () => {
		expect((await toolA({}, "coord.ts", "governance", "solo")).code).toBe(0);
		const id = await addItem("governance solo belt-direct item");
		const sid = laneSid(id, projectIdentity(REPO));
		const out = await dispatchA({ PATH: "/usr/bin:/bin" }, "--item", id);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain("BELT-DIRECT DISPATCH");
		expect(out.out).toContain("governance:solo");
		expect(out.out).toContain("executor exited during launch");
		expect(out.out).not.toContain("(pid");
		const brief = readFileSync(join(REPO, ".fleet", `brief-${sid}.md`), "utf8");
		expect(brief).toContain("GOVERNANCE: BELT-DIRECT DISPATCH");
		// restore the default so the scratch db ends strict
		expect((await toolA({}, "coord.ts", "governance", "strict")).code).toBe(0);
	}, 60_000);
});

test("actual orphan CLI feed exceeds 64 KiB without losing trailing claims", async () => {
	expect(tool("work.ts", "add", "large feed initializer").code).toBe(0);
	const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
	const insert = db.query(
		"INSERT INTO work_items(project,id,title,description,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
	);
	try {
		for (let i = 0; i < 100; i++)
			insert.run(
				projectIdentity(REPO),
				`W${900000 + i}`,
				"large feed fixture",
				"x".repeat(2000),
				"CLAIMED",
				"manual-fixture",
				Date.now(),
				Date.now(),
			);
		const rows = await captureClaimFeed(
			[process.execPath, join(BIN, "work.ts"), "orphaned", "--json"],
			REPO,
			{ env },
		);
		expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(65536);
		expect(rows.some((row) => row.id === "W900099")).toBe(true);
	} finally {
		db.query("DELETE FROM work_items WHERE project=? AND owner_sid=?").run(
			projectIdentity(REPO),
			"manual-fixture",
		);
		db.close();
	}
}, 60_000);

test("malformed recovery feed is a visible refusal before dispatch or claims", () => {
	const prefix = join(HOME, "invalid-feed-prefix");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	for (const name of ["coord.ts", "worktree.ts"])
		symlinkSync(join(BIN, name), join(prefix, "bin", name));
	writeFileSync(
		join(prefix, "bin/work.ts"),
		`if(process.argv[2]==="orphaned")console.log("[{");else{const p=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},...process.argv.slice(2)],{stdout:"pipe",stderr:"pipe"});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.exitCode);}
`,
	);
	const id =
		(tool("work.ts", "add", "invalid feed must not dispatch").out.match(
			/W\d+/,
		) ?? [])[0] ?? "";
	const result = dispatchWith(
		{ SUSPENDERS_PREFIX: prefix },
		"--item",
		id,
		"--dry-run",
	);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("RECOVERY REFUSED");
	expect(result.err).toContain("invalid or incomplete structured feed");
	expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
		"READY",
	);
	expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
});
