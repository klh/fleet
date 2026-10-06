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
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeBrief,
	isOwnerGated,
	laneKeyDecision,
	parseCapsuleGet,
	parseReady,
} from "../scripts/dispatch-next.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w145-dispatch-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w145-dispatch-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
// W463: pin the buckle front to a dead port for the legacy cases — probe
// misses = belt-direct note path (pre-W463 behavior), deterministic even on
// a machine with a live spoke on :4101. Fail-closed refusal/override get
// their own stub-front cases below.
const env = {
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
	test("prints chosen item + full brief, takes nothing, spawns nothing", () => {
		const added = tool("work.ts", "add", "sample lane mission");
		id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--target", "1");
		expect(out.out).toContain(`DRY dispatch ${id}`);
		expect(out.out).toContain("CAPSULE PROTOCOL");
		expect(out.out).toContain("LANDING CHAIN");
		expect(out.out).toContain(`lane "autow${id.slice(1)}"`);
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
// ─── W463 fail-closed governance + lane key lifecycle ──────────────────────
// NOTE: e2e cases here spawn dispatch-next/worktree async (Bun.spawn, not
// spawnSync): a sync spawn blocks this process' event loop, which would stall
// the stub buckle front and make the child's 600ms front probe time out.

const stubBuckle = (): {
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

	test("--allow-ungoverned proceeds with loud note + brief disclosure (no spawn: executor absent)", async () => {
		const stub = stubBuckle();
		const id = await addItem("ungoverned override e2e item");
		const sid = `autow${id.slice(1)}`;
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
		expect(out.code).toBe(0);
		expect(out.out).toContain("UNGOVERNED DISPATCH — operator override");
		expect(out.out).toContain("SKIP — executor binary not found");
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

describe("lane key lifecycle (W463)", () => {
	test("worktree retire revokes the lane key and removes per-lane files", async () => {
		const stub = stubBuckle();
		const id = await addItem("lane key lifecycle item");
		const sid = `autow${id.slice(1)}`;
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
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
			stub.calls.some((c) => c.includes("/v1/admin/keys/deadbeefcafe/revoke")),
		).toBe(true);
		expect(existsSync(metaPath)).toBe(false);
		expect(existsSync(settingsPath)).toBe(false);
		stub.stop();
	}, 60_000);
});
