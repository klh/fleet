// test/tool-failures.test.ts — W514: the in-session tool-failure retry
// counter with anti-thrash at >=5 (claudecode research §1.5). Unit leg pins
// the keying/noise/window rules; the gate leg spawns the REAL gate.ts
// post-fail on a payload stream and pins the escalation ladder (silent,
// analyze, anti-thrash) with state isolated in a temp TMPDIR.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	failKey,
	isNoise,
	recordToolFailure,
	ANTI_THRASH_AT,
} from "../hooks/lib/tool-failures.ts";
import { sessionStatePath } from "../hooks/lib/session-state.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-toolfail-"));
const REPO = TMP;

let n = 0;
function gate(
	sid: string,
	response: Record<string, unknown>,
	command = "make bad",
): { out: string; err: string; code: number | null } {
	const pf = join(TMP, `payload-${n++}.json`);
	writeFileSync(
		pf,
		JSON.stringify({
			tool_name: "Bash",
			session_id: sid,
			tool_input: { command },
			tool_response: response,
		}),
	);
	const p = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "post-fail"],
		{
			cwd: REPO,
			env: { ...process.env, TMPDIR: TMP },
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("tool-failure lib", () => {
	test("failKey is stable per tool+input and truncated", () => {
		const a = failKey("Bash", { command: "x" });
		const b = failKey("Bash", { command: "x" });
		expect(a).toBe(b);
		expect(a.startsWith("Bash:")).toBe(true);
		expect(
			failKey("Bash", { command: "y".repeat(500) }).length,
		).toBeLessThanOrEqual(206);
	});

	test("isNoise: chain-handled failures, permission-denied scans, method-not-found", () => {
		expect(isNoise("make bad || true", "boom")).toBe(true);
		expect(isNoise("rg needle /", "permission denied")).toBe(true);
		expect(isNoise(undefined, "method not found")).toBe(true);
		expect(isNoise("make bad", "boom")).toBe(false);
		expect(isNoise("rg needle /", "compile error")).toBe(false);
	});

	test("ladder: silent, analyze, anti-thrash — then window expiry resets", async () => {
		const sid = `tf-${Math.random().toString(36).slice(2)}`;
		const input = { command: "make bad" };
		for (let i = 1; i <= 2; i++)
			expect(recordToolFailure(sid, "Bash", input, "boom").guidance).toBeNull();
		const third = recordToolFailure(sid, "Bash", input, "boom");
		expect(third.count).toBe(3);
		expect(third.guidance).toContain("tool-failures: Bash failed 3x");
		for (let i = 4; i < ANTI_THRASH_AT; i++)
			expect(
				recordToolFailure(sid, "Bash", input, "boom").guidance,
			).toContain("analyze the error");
		const at = recordToolFailure(sid, "Bash", input, "boom");
		expect(at.count).toBe(ANTI_THRASH_AT);
		expect(at.guidance).toContain("Anti-thrash (Bash)");
		// window expiry: forge a state where the last failure is > 60s old
		const file = sessionStatePath("toolfail", sid);
		const state = JSON.parse(await Bun.file(file).text());
		state[failKey("Bash", input)].last = Date.now() - 61_000;
		await Bun.write(file, JSON.stringify(state));
		const after = recordToolFailure(sid, "Bash", input, "boom");
		expect(after.count).toBe(1);
		expect(after.guidance).toBeNull();
	});
});

describe("post-fail gate", () => {
	test("escalates: silent x2 → analyze x2 → anti-thrash at 5", () => {
		const sid = `gate-${Math.random().toString(36).slice(2)}`;
		expect(gate(sid, { is_error: true, stderr: "boom" })).toEqual({
			out: "{}",
			err: "",
			code: 0,
		});
		expect(gate(sid, { is_error: true, stderr: "boom" }).out).toBe("{}");
		const third = gate(sid, { is_error: true, stderr: "boom" });
		expect(third.code).toBe(2);
		expect(third.err).toContain("tool-failures: Bash failed 3x");
		const fourth = gate(sid, { is_error: true, stderr: "boom" });
		expect(fourth.code).toBe(2);
		const fifth = gate(sid, { is_error: true, stderr: "boom" });
		expect(fifth.code).toBe(2);
		expect(fifth.err).toContain("Anti-thrash (Bash)");
	});

	test("success and interrupts never count", () => {
		const sid = `gate-ok-${Math.random().toString(36).slice(2)}`;
		expect(gate(sid, { is_error: false }).out).toBe("{}");
		expect(gate(sid, { is_error: true, interrupted: true }).out).toBe("{}");
		expect(existsSync(sessionStatePath("toolfail", sid))).toBe(false); // nothing recorded
	});

	test("noise classes never count", () => {
		const sid = `gate-noise-${Math.random().toString(36).slice(2)}`;
		for (let i = 0; i < 6; i++)
			expect(
				gate(sid, { is_error: true, stderr: "x" }, "ls /nope || true").out,
			).toBe("{}");
		expect(existsSync(sessionStatePath("toolfail", sid))).toBe(false);
	});
});
