// test/runaway-gate.test.ts — W830 runaway-guard: lib units (stableKey,
// scanTail, rate math, incremental usage scan) + the REAL gate spawn with
// fixture transcripts (ask-gate recipe: temp-file stdin, fixture HOME).
// Advisory law asserted: unreadable evidence allows, never blocks.
import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(20_000);
const HOME = mkdtempSync(join(tmpdir(), "suspenders-runaway-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-runaway-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const gate = join(import.meta.dir, "..", "hooks", "gate.ts");

// transcript row builders — mirror live Claude transcript shapes
const use = (id: string, name: string, input: unknown): string =>
	`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })}\n`;
const res = (tid: string, isErr: boolean, content: string): string =>
	`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid, is_error: isErr, content }] } })}\n`;
const urow = (model: string, u: Record<string, number>): string =>
	`${JSON.stringify({ type: "assistant", message: { model, usage: u } })}\n`;

const KNOBS = {
	SUSPENDERS_RUNAWAY: "",
	SUSPENDERS_RUNAWAY_REPEAT_MAX: "",
	SUSPENDERS_RUNAWAY_FAIL_STREAK: "",
	SUSPENDERS_RUNAWAY_USD_CAP: "",
	SUSPENDERS_RUNAWAY_USD_RATES: "",
	SUSPENDERS_RUNAWAY_TAIL_BYTES: "",
	SUSPENDERS_RUNAWAY_SCAN_CAP_BYTES: "",
};

// the REAL gate spawn: fixture transcript + temp-file stdin (Bun spawnSync
// drops `input`); knobs pinned empty so ambient env can't leak in
function runGate(
	transcript: string,
	payload: { tool_name: string; tool_input?: unknown },
	over: Record<string, string> = {},
	sid = `runaway-sid-${Math.random().toString(36).slice(2, 8)}`,
): { code: number; out: string; json: GateDecision | null } {
	const tp = join(HOME, `tp-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(tp, transcript);
	const pf = join(HOME, `pay-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(
		pf,
		JSON.stringify({
			session_id: sid,
			tool_name: payload.tool_name,
			tool_input: payload.tool_input ?? {},
			transcript_path: tp,
			cwd: REPO,
		}),
	);
	const p = Bun.spawnSync(["bun", gate, "runaway"], {
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME, ...KNOBS, ...over },
	});
	const out = p.stdout.toString();
	try {
		rmSync(tp, { force: true });
	} catch {}
	try {
		rmSync(pf, { force: true });
	} catch {}
	return { code: p.exitCode, out, json: parseHookJson(out) };
}

type GateDecision = {
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
	};
};

function parseHookJson(out: string): GateDecision | null {
	try {
		return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as GateDecision;
	} catch {
		return null;
	}
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("runaway lib units", () => {
	test("stableKey is key-order invariant and capped", async () => {
		const { stableKey } = await import("../hooks/lib/gates/runaway.ts");
		expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
	});

	test("scanTail counts identical repeats past calls only", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const t =
			use("t1", "Bash", { command: "bun test" }) +
			res("t1", false, "ok") +
			use("t2", "Bash", { command: "bun test" }) +
			res("t2", false, "ok");
		const v = scanTail(t, "Bash", stableKey({ command: "bun test" }));
		expect(v.repeats).toBe(2);
		expect(v.failStreak).toBe(0);
	});

	test("W1079: a different call breaks the run — spaced rerun counts 1", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		// TDD loop: test → edit → test → edit → test; the two edits break
		// both runs, so the pending rerun rides a trailing run of 1
		const t =
			use("t1", "Bash", { command: "bun test" }) +
			res("t1", false, "ok") +
			use("e1", "Edit", { file_path: "a.ts" }) +
			res("e1", false, "ok") +
			use("t2", "Bash", { command: "bun test" }) +
			res("t2", false, "ok") +
			use("e2", "Edit", { file_path: "a.ts" }) +
			res("e2", false, "ok") +
			use("t3", "Bash", { command: "bun test" }) +
			res("t3", false, "ok");
		const v = scanTail(t, "Bash", stableKey({ command: "bun test" }));
		expect(v.repeats).toBe(1);
	});

	test("W1079: a later different call caps the run at zero for a rerun", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const t =
			use("t1", "Bash", { command: "bun test" }) +
			res("t1", false, "ok") +
			use("t2", "Bash", { command: "bun test" }) +
			res("t2", false, "ok") +
			use("t3", "Bash", { command: "bun test" }) +
			res("t3", false, "ok") +
			use("e1", "Edit", { file_path: "a.ts" }) +
			res("e1", false, "ok");
		const v = scanTail(t, "Bash", stableKey({ command: "bun test" }));
		expect(v.repeats).toBe(0);
	});

	test("scanTail drops a partial first line", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const t =
			`{"type":"assi` +
			use("t1", "Bash", { command: "x" }) +
			res("t1", false, "ok");
		const v = scanTail(t, "Bash", stableKey({ command: "y" }));
		expect(v.repeats).toBe(0);
	});
});

describe("runaway streak + rates", () => {
	test("fail streak: trailing errors count, success resets", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const t =
			use("a", "Bash", { command: "ok1" }) +
			res("a", false, "fine") +
			use("b", "Bash", { command: "bad1" }) +
			res("b", true, "boom") +
			use("c", "Bash", { command: "bad2" }) +
			res("c", true, "boom");
		const v = scanTail(t, "Bash", stableKey({ command: "zz" }));
		expect(v.failStreak).toBe(2);
	});

	test("noise failures are transparent to the streak", async () => {
		const { scanTail, stableKey } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const t =
			use("n", "Bash", { command: "ls x || true" }) +
			res("n", true, "boom") +
			use("a", "cap", { command: "bad1" }) +
			res("a", true, "boom");
		const v = scanTail(t, "Bash", stableKey({ command: "zz" }));
		expect(v.failStreak).toBe(1);
	});

	test("rateRowFor: longest prefix wins, * is the fallback tier", async () => {
		const { rateRowFor } = await import("../hooks/lib/gates/runaway.ts");
		const rates = {
			"gpt-5": { out: 1 },
			"gpt-5-mini": { out: 2 },
			"*": { in: 3 },
		};
		expect(rateRowFor("gpt-5-mini-2026", rates)?.out).toBe(2);
		expect(rateRowFor("gpt-5-2026", rates)?.out).toBe(1);
		expect(rateRowFor("other", rates)?.in).toBe(3);
		expect(rateRowFor("other", {})).toBeNull();
	});
});

describe("readUsageDelta", () => {
	test("incremental: offset advances, totals accumulate", async () => {
		const { readUsageDelta, zeroUsage } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const tp = join(HOME, "usage.jsonl");
		writeFileSync(tp, urow("m", { input_tokens: 1_000_000, output_tokens: 0 }));
		const rates = { "*": { in: 3 } };
		const s1 = readUsageDelta(tp, zeroUsage(), rates);
		expect(s1.costUsd).toBe(3);
		// append + rescan: only the delta counts (1e6 more in-tokens, $3 more)
		appendFileSync(
			tp,
			urow("m", { input_tokens: 1_000_000, output_tokens: 100_000 }),
		);
		const s2 = readUsageDelta(tp, s1, rates);
		expect(s2.costUsd).toBeCloseTo(6, 6);
		expect(s2.offset).toBeGreaterThan(s1.offset);
		rmSync(tp, { force: true });
	});

	test("truncation restarts bounded, no regression", async () => {
		const { readUsageDelta, zeroUsage, parseRates } = await import(
			"../hooks/lib/gates/runaway.ts"
		);
		const tp = join(HOME, "usage2.jsonl");
		writeFileSync(
			tp,
			urow("m", { input_tokens: 500_000 }) +
				urow("m", { input_tokens: 500_000 }),
		);
		const rates = parseRates('{"*":{"in":2}}');
		const s1 = readUsageDelta(tp, zeroUsage(), rates);
		expect(s1.costUsd).toBe(2);
		// file rewritten SMALLER: bounded rescan from size - cap, cost recounts
		writeFileSync(tp, urow("m", { input_tokens: 1_000_000 }));
		const s2 = readUsageDelta(tp, s1, rates, 65_536);
		expect(s2.costUsd).toBeGreaterThanOrEqual(2);
		// a trailing partial line (no \n) never advances the offset
		appendFileSync(tp, '{"type":"assistant","message":{"mo');
		const s3 = readUsageDelta(tp, s2, rates, 65_536);
		expect(s3.offset).toBe(s2.offset);
		rmSync(tp, { force: true });
	});
});

describe("runaway gate (real spawn)", () => {
	const cmd = { command: "bun test" };

	test("healthy transcript allows silently", () => {
		const t =
			use("t1", "Bash", cmd) +
			res("t1", false, "ok") +
			urow("glm", { input_tokens: 1000, output_tokens: 10 });
		const r = runGate(t, { tool_name: "Bash", tool_input: cmd });
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("{}");
	});

	test("kill switch SUSPENDERS_RUNAWAY=0 allows past a repeat", () => {
		const t =
			use("t1", "Bash", cmd) +
			res("t1", false, "ok") +
			use("t2", "Bash", cmd) +
			res("t2", false, "ok") +
			use("t3", "Bash", cmd) +
			res("t3", false, "ok");
		const r = runGate(
			t,
			{ tool_name: "Bash", tool_input: cmd },
			{
				SUSPENDERS_RUNAWAY: "0",
			},
		);
		expect(r.out.trim()).toBe("{}");
	});
});

describe("runaway gate: repeat + streak breakers", () => {
	const cmd = { command: "bun test" };

	test("identical call at/over repeatMax blocks with a redirect note", () => {
		const t =
			use("t1", "Bash", cmd) +
			res("t1", false, "ok") +
			use("t2", "Bash", cmd) +
			res("t2", false, "ok") +
			use("t3", "Bash", cmd) +
			res("t3", false, "ok");
		const r = runGate(t, { tool_name: "Bash", tool_input: cmd });
		expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
		expect(r.json?.hookSpecificOutput?.permissionDecisionReason).toContain(
			"runaway-guard",
		);
	});

	test("W1079: spaced reruns of a TDD loop allow — interleaved edits break the run", () => {
		const t =
			use("t1", "Bash", cmd) +
			res("t1", false, "ok") +
			use("e1", "Edit", { file_path: "a.ts" }) +
			res("e1", false, "ok") +
			use("t2", "Bash", cmd) +
			res("t2", false, "ok") +
			use("e2", "Edit", { file_path: "a.ts" }) +
			res("e2", false, "ok") +
			use("t3", "Bash", cmd) +
			res("t3", false, "ok");
		const r = runGate(t, { tool_name: "Bash", tool_input: cmd });
		expect(r.out.trim()).toBe("{}");
	});

	test("fail streak at cap blocks; below cap allows", () => {
		let t = "";
		for (let i = 0; i < 6; i++)
			t +=
				use(`f${i}`, "Bash", { command: `bad ${i}` }) +
				res(`f${i}`, true, "boom");
		const blocked = runGate(t, {
			tool_name: "Bash",
			tool_input: { command: "next" },
		});
		expect(blocked.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
		const allowed = runGate(
			t.slice(0, t.length - res("x", true, "boom").length),
			{ tool_name: "Bash", tool_input: { command: "next" } },
		);
		expect(allowed.out.trim()).toBe("{}");
	});
});

describe("runaway gate: dollar breaker", () => {
	const cmd = { command: "bun test" };

	test("dollar cap over rates blocks", () => {
		const t = urow("glm", { input_tokens: 1_000_000, output_tokens: 100_000 });
		const blocked = runGate(
			t,
			{ tool_name: "Bash", tool_input: cmd },
			{
				SUSPENDERS_RUNAWAY_USD_CAP: "4",
				SUSPENDERS_RUNAWAY_USD_RATES: '{"*":{"in":3,"out":15}}',
			},
		);
		expect(blocked.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
	});
});

describe("runaway incidents + usage state", () => {
	const cmd = { command: "bun test" };

	test("dollar deny appends the lane incidents.jsonl line", () => {
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		const t = urow("glm", { input_tokens: 1_000_000 });
		const r = runGate(
			t,
			{ tool_name: "Bash", tool_input: cmd },
			{
				SUSPENDERS_RUNAWAY_USD_CAP: "0.01",
				SUSPENDERS_RUNAWAY_USD_RATES: '{"*":{"in":3}}',
			},
		);
		expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
		const lines = readFileSync(join(REPO, ".fleet/incidents.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { rule: string });
		expect(lines.some((x) => x.rule === "dollar")).toBe(true);
	});

	test("usage state file banks offset + costUsd", () => {
		const sid = "runaway-sid-state0001";
		const t = urow("glm", { input_tokens: 2_000_000 });
		const r = runGate(
			t,
			{ tool_name: "Bash", tool_input: cmd },
			{ SUSPENDERS_RUNAWAY_USD_RATES: '{"*":{"in":1}}' },
			sid,
		);
		expect(r.out.trim()).toBe("{}"); // no cap → allow, but state banks
		const st = readFileSync(
			join(process.env.TMPDIR ?? "/tmp", `claude-runaway-usage-${sid}.json`),
			"utf8",
		);
		const parsed = JSON.parse(st) as { costUsd: number; offset: number };
		expect(parsed.costUsd).toBe(2);
		expect(parsed.offset).toBeGreaterThan(0);
	});
});
