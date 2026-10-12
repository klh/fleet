// test/lane-starter.test.ts — W454: versioned starter sessions + forked lane
// starts. Covered: seed prompt credential guard, version stability, seed
// once/reuse via the registry, fork args per harness, parseSessionId, and the
// dispatch-facing dispatchStarterFork wiring (flag off / claude fork /
// unsupported harness / seed failure fallback).
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoSecrets,
	dispatchStarterFork,
	ensureStarter,
	forkArgsFor,
	laneIdentityPrompt,
	parseSessionId,
	starterEnabled,
	starterSeedPrompt,
	starterVersion,
	STARTER_FLAG,
} from "../scripts/lib/lane-starter.ts";

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
		expect(first?.sessionId).toBe("seed-1");
		expect(first?.forkArgs).toEqual(["--resume", "seed-1", "--fork-session"]);
		const again = ensureStarter(
			fleet,
			"claude",
			"/bin/real-claude",
			{},
			{ run: runStub },
		);
		expect(runs).toBe(1);
		expect(again?.sessionId).toBe("seed-1");
		expect(again?.version).toBe(first?.version);
	});

	test("ensureStarter returns null and logs on seed failure", () => {
		const logs: string[] = [];
		const out = ensureStarter(fleet, "claude", "/bin/true", {}, {
			run: () => ({ code: 1, out: "boom" }),
			log: (l) => logs.push(l),
		} as never);
		expect(out).toBeNull();
		expect(logs.join(" ")).toMatch(/seed failed/);
	});

	test("forkArgsFor: claude only, others catalog-only", () => {
		expect(forkArgsFor("claude", "s1")).toEqual([
			"--resume",
			"s1",
			"--fork-session",
		]);
		for (const h of ["copilot", "codex", "gemini", "grok"]) {
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

	test("dispatchStarterFork: flag off = cold prompt, no fork args", async () => {
		const r = await dispatchStarterFork({
			env: {},
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
		expect(r).toEqual({ forkArgs: [], prompt: "COLD" });
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
		expect(r).toEqual({ forkArgs: [], prompt: "COLD" });
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
});
