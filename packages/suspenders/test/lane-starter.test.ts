// test/lane-starter.test.ts — W454: versioned starter sessions + forked lane
// starts. Covered: seed prompt credential guard, version stability, seed
// once/reuse via the registry, fork args per harness, parseSessionId, and the
// dispatch-facing dispatchStarterFork wiring (flag off / claude fork /
// unsupported harness / seed failure fallback).
import { describe, expect, test, afterEach } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoSecrets,
	dispatchStarterFork,
	ensureStarter,
	flattenTail,
	forkArgsFor,
	laneIdentityPrompt,
	parseSessionId,
	starterEnabled,
	starterSeedPrompt,
	starterStartLine,
	starterVersion,
	STARTER_FLAG,
	STARTER_SAVED_S,
} from "../scripts/lib/lane-starter.ts";
import { WORKER_MANAGED_PROFILE } from "../hooks/lib/executors/claude.ts";

const scratch = (): string => {
	const d = join(
		tmpdir(),
		`w454-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(d, { recursive: true });
	return d;
};

describe("lane-starter", () => {
	const fleet = scratch();
	afterEach(() => {
		if (existsSync(fleet)) rmSync(fleet, { recursive: true, force: true });
	});

	test("seed prompt carries no credential material and guard rejects it", () => {
		const seed = starterSeedPrompt();
		expect(() => assertNoSecrets(seed)).not.toThrow();
		expect(() =>
			assertNoSecrets("use token ghp_ABCDEFGHIJ1234 for upstream"),
		).toThrow();
		expect(() =>
			assertNoSecrets("bksk_abcdefghijklmnop and sk-live-abcdef123456"),
		).toThrow();
	});

	test("starter version is content-derived and stable", () => {
		expect(starterVersion("same text")).toBe(starterVersion("same text"));
		expect(starterVersion("same text")).not.toBe(starterVersion("other"));
	});

	// W1124.12: the managed worker profile is part of the version hash — a
	// profile change supersedes every cached starter session without touching
	// the seed prompt text.
	test("starter version invalidates when the managed profile changes", () => {
		const before = starterVersion("seed");
		const savedMcp = WORKER_MANAGED_PROFILE.mcpConfig;
		const savedTools = WORKER_MANAGED_PROFILE.tools;
		try {
			WORKER_MANAGED_PROFILE.mcpConfig = `{"mcpServers":{"drifted":{}}}`;
			expect(starterVersion("seed")).not.toBe(before);
			WORKER_MANAGED_PROFILE.mcpConfig = savedMcp;
			WORKER_MANAGED_PROFILE.tools = "Bash";
			expect(starterVersion("seed")).not.toBe(before);
		} finally {
			WORKER_MANAGED_PROFILE.mcpConfig = savedMcp;
			WORKER_MANAGED_PROFILE.tools = savedTools;
		}
		expect(starterVersion("seed")).toBe(before);
	});

	test("ensureStarter seeds once then reuses the registry", () => {
		let runs = 0;
		const runStub = () => {
			runs++;
			return {
				code: 0,
				out: `${JSON.stringify({ session_id: "seed-1", type: "result" })}\n`,
			};
		};
		const first = ensureStarter(
			fleet,
			"claude",
			"/bin/true",
			{},
			{ run: runStub },
		);
		expect(first).not.toBeNull();
		expect(first?.kind).toBe("fork");
		expect(first?.fork.sessionId).toBe("seed-1");
		expect(first?.fork.forkArgs).toEqual([
			"--resume",
			"seed-1",
			"--fork-session",
		]);
		const again = ensureStarter(
			fleet,
			"claude",
			"/bin/real-claude",
			{},
			{ run: runStub },
		);
		expect(runs).toBe(1);
		expect(again?.fork.sessionId).toBe("seed-1");
		expect(again?.fork.version).toBe(first?.fork.version);
	});

	test("ensureStarter returns the failure record and logs on seed failure", () => {
		const logs: string[] = [];
		const out = ensureStarter(fleet, "claude", "/bin/true", {}, {
			run: () => ({ code: 1, out: "boom" }),
			log: (l) => logs.push(l),
		} as never);
		expect(out?.kind).toBe("failure");
		expect(out?.failure.phase).toBe("starter-seed");
		expect(out?.failure.code).toBe(1);
		expect(out?.failure.stderrTail).toBe("boom");
		expect(logs.join(" ")).toMatch(/seed failed/);
	});

	test("ensureStarter: stderr is captured separately from stdout", () => {
		const out = ensureStarter(fleet, "claude", "/bin/true", {}, {
			run: () => ({
				code: 1,
				out: `${JSON.stringify({ type: "result" })}\n`,
				err: "unrecognized model line\ntrace tail",
			}),
		} as never);
		expect(out?.kind).toBe("failure");
		expect(out?.failure.stderrTail).toContain("unrecognized model line");
	});

	test("flattenTail bounds and flattens", () => {
		expect(flattenTail("a\nb\n c")).toBe("a b c");
		const long = "x".repeat(400);
		const t = flattenTail(long);
		expect(t.length).toBe(220);
		expect(t.startsWith("…")).toBe(true);
	});

	test("forkArgsFor: claude only, others catalog-only", () => {
		// W918.3: copilot joined the fork set (--session-id, live-verified on
		// 1.0.98); the legacy name stays — the W833 claim-check matches test
		// NAMES, so a rename reads as a deleted test. Assertions are truth.
		expect(forkArgsFor("claude", "s1")).toEqual([
			"--resume",
			"s1",
			"--fork-session",
		]);
		expect(forkArgsFor("copilot", "s1")).toEqual(["--session-id", "s1"]);
		for (const h of ["codex", "gemini", "grok"]) {
			expect(forkArgsFor(h, "s1")).toBeNull();
		}
	});

	test("parseSessionId tolerates leading log lines and rejects junk", () => {
		expect(parseSessionId('noise\n{"session_id":"abc"}')).toBe("abc");
		expect(parseSessionId("no json here")).toBeNull();
		expect(parseSessionId('{"session_id":42}')).toBeNull();
	});

	test("laneIdentityPrompt carries sid + worktree, never the seed", () => {
		const p = laneIdentityPrompt("autow7", "/wt/x");
		expect(p).toContain("autow7");
		expect(p).toContain("/wt/x/.klh-brief.md");
	});

	test("dispatchStarterFork: explicit off = cold prompt, no fork args", async () => {
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "off" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W454",
			sid: "s1",
			wt: "/wt",
			coldPrompt: "COLD",
			log: () => {},
		});
		expect(r).toEqual({
			forkArgs: [],
			prompt: "COLD",
			starter: { mode: "cold", reason: "SUSPENDERS_LANE_STARTER=off" },
		});
	});

	test("W1124.12.1: opt-in — flag on forks; bare env cold-starts", async () => {
		const logs: string[] = [];
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W768",
			sid: "s768",
			wt: "/wt768",
			coldPrompt: "COLD",
			log: (l) => logs.push(l),
			ensureOpts: {
				run: () => ({
					code: 0,
					out: `${JSON.stringify({ session_id: "seed-768" })}\n`,
				}),
			},
		});
		expect(r.forkArgs).toEqual(["--resume", "seed-768", "--fork-session"]);
		expect(r.prompt).toContain("s768");
		expect(logs.join(" ")).toMatch(/forked/);
		expect(starterEnabled({ [STARTER_FLAG]: "on" })).toBe(true);
		expect(starterEnabled({})).toBe(false);
		expect(starterEnabled({ [STARTER_FLAG]: "0" })).toBe(false);
	});

	test("dispatchStarterFork: codex = catalog-only, cold start", async () => {
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "codex",
			fleet,
			bin: "/bin/true",
			item: "W454",
			sid: "s1",
			wt: "/wt",
			coldPrompt: "COLD",
			log: () => {},
		});
		expect(r).toEqual({
			forkArgs: [],
			prompt: "COLD",
			starter: { mode: "cold", reason: "no fork adapter for codex" },
		});
	});

	test("dispatchStarterFork: claude + flag on = seeded fork", async () => {
		const logs: string[] = [];
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W454",
			sid: "s2",
			wt: "/wt2",
			coldPrompt: "COLD",
			log: (l) => logs.push(l),
			ensureOpts: {
				run: () => ({
					code: 0,
					out: `${JSON.stringify({ session_id: "seed-2" })}\n`,
				}),
			},
		});
		expect(r.forkArgs).toEqual(["--resume", "seed-2", "--fork-session"]);
		expect(r.prompt).toContain("s2");
		expect(logs.join(" ")).toMatch(/forked/);
	});

	test("dispatchStarterFork: seed failure carries exit code + stderr tail", async () => {
		const logs: string[] = [];
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W695.1",
			sid: "s3",
			wt: "/wt3",
			coldPrompt: "COLD",
			log: (l) => logs.push(l),
			ensureOpts: {
				run: () => ({ code: 7, err: "connect ECONNREFUSED 127.0.0.1:4000" }),
			},
		});
		expect(r.forkArgs).toEqual([]);
		expect(r.prompt).toBe("COLD");
		expect(r.seedError?.phase).toBe("starter-seed");
		expect(r.seedError?.code).toBe(7);
		expect(r.seedError?.stderrTail).toContain("ECONNREFUSED");
		expect(r.seedError?.preflight).toBeUndefined();
		expect(logs.join(" ")).toMatch(/seed failed/);
	});

	test("dispatchStarterFork: preflight down rides the seedError", async () => {
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: false,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W695.1",
			sid: "s4",
			wt: "/wt4",
			coldPrompt: "COLD",
			log: () => {},
			probe: async () => null,
			ensureOpts: {
				run: () => ({ code: 1, err: "seed died" }),
			},
		});
		expect(r.seedError?.preflight).toContain("belt-front down");
	});

	test("dispatchStarterFork: preflight up verdict rides the seedError", async () => {
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: false,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W695.1",
			sid: "s5",
			wt: "/wt5",
			coldPrompt: "COLD",
			log: () => {},
			probe: async () => "http://127.0.0.1:4101",
			ensureOpts: {
				run: () => ({ code: 1, err: "seed died" }),
			},
		});
		expect(r.seedError?.preflight).toContain("belt-front up");
	});

	test("W818: seeded fork outcome carries source, seed cost, saved seconds", async () => {
		const logs: string[] = [];
		const r = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W818",
			sid: "s818a",
			wt: "/wt818a",
			coldPrompt: "COLD",
			log: (l) => logs.push(l),
			ensureOpts: {
				run: () => ({
					code: 0,
					out: `${JSON.stringify({ session_id: "seed-w818a" })}\n`,
				}),
			},
		});
		expect(r.starter).toEqual({
			mode: "fork",
			source: "seeded",
			version: expect.any(String),
			session: "seed-w818a",
			seedMs: expect.any(Number),
			savedS: STARTER_SAVED_S,
		});
	});

	test("W818: second dispatch reuses the registry — outcome source=cached", async () => {
		const seeded = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W818",
			sid: "s818b",
			wt: "/wt818b",
			coldPrompt: "COLD",
			log: () => {},
			ensureOpts: {
				run: () => ({
					code: 0,
					out: `${JSON.stringify({ session_id: "seed-w818b" })}\n`,
				}),
			},
		});
		expect(seeded.starter?.source).toBe("seeded");
		const cached = await dispatchStarterFork({
			env: { [STARTER_FLAG]: "on" },
			noBelt: true,
			harness: "claude",
			fleet,
			bin: "/bin/true",
			item: "W818",
			sid: "s818c",
			wt: "/wt818c",
			coldPrompt: "COLD",
			log: () => {},
			ensureOpts: {
				run: () => {
					throw new Error("registry hit must not re-run the seed");
				},
			},
		});
		expect(cached.starter?.mode).toBe("fork");
		expect(cached.starter?.source).toBe("cached");
	});

	test("W818: cold outcomes render the reason; fork line names source+saved", () => {
		expect(starterStartLine("W818", { mode: "cold", reason: "flag off" })).toBe(
			"STARTER W818 — cold start (flag off)",
		);
		expect(
			starterStartLine("W818", {
				mode: "fork",
				source: "cached",
				version: "f4dae8ae032c",
				session: "e02f5a14",
				savedS: STARTER_SAVED_S,
			}),
		).toBe(
			"STARTER W818 — forked starter f4dae8ae032c (cached, session e02f5a14; saved ≈60.3s vs cold, W768 bench)",
		);
	});

	// W1124.12.1: the seed turn hangs for real when the executor wedges —
	// the NATIVE `timeout` option enforces the deadline (the old `timeoutMs`
	// field was silently ignored). NARROW contract: the SIGTERM lands on the
	// DIRECT child (the fixture sh wrapper); descendants are NOT guaranteed
	// to die with it — the test reaps the fixture's survivor itself.
	test("the direct seed child is killed within the declared budget", () => {
		// afterEach removed the shared fleet dir — ensureStarter spawns with
		// cwd: fleet, so it must exist for the real spawnSync.
		mkdirSync(fleet, { recursive: true });
		const d = scratch();
		const hung = join(d, "hung-seed.sh");
		writeFileSync(hung, "#!/bin/sh\nsleep 30\n");
		chmodSync(hung, 0o700);
		const seedMs = 1_000;
		const t0 = Date.now();
		const r = ensureStarter(
			fleet,
			"claude",
			hung,
			{ PATH: "/usr/bin:/bin" },
			{
				timeoutMs: seedMs,
			},
		);
		const elapsed = Date.now() - t0;
		// the hung seed prints no session id → the failure record
		expect(r?.kind).toBe("failure");
		// budget + SIGTERM overhead — NOT the fixture's full 30s runtime
		expect(elapsed).toBeLessThan(10_000);
		expect(elapsed).toBeGreaterThanOrEqual(seedMs);
		// narrow-contract hygiene: reap the wrapper's surviving descendant
		Bun.spawnSync(["/usr/bin/pkill", "-f", hung]);
		rmSync(d, { recursive: true, force: true });
	}, 15_000);
});
