// packages/suspenders/test/resume-from.test.ts — W622 retake knob: the
// fence chain (policy → executor → claim → freshness) and the dispatch
// helpers, with injectable transcript/time so tests never touch the real
// ~/.claude/projects tree. The blam paired eval (bench/paired,
// resumePolicyVerdict) owns the POLICY verdict; these tests own the
// fence mechanics.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decisionFor,
	RESUME_RETAKE_FLAG,
	resolveResumeFrom,
	resumeBriefLine,
	retakeTtlMin,
} from "../scripts/lib/resume-from.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

// real temp transcripts — the freshness fence stats mtimes for real
const dir = mkdtempSync(join(tmpdir(), "resume-from-"));
const warm = join(dir, "warm.jsonl");
const stale = join(dir, "stale.jsonl");
writeFileSync(warm, "");
utimesSync(warm, new Date(NOW - 2 * 60_000), new Date(NOW - 2 * 60_000));
writeFileSync(stale, "");
utimesSync(stale, new Date(NOW - 20 * 60_000), new Date(NOW - 20 * 60_000));

const opts = (
	over: Partial<Parameters<typeof resolveResumeFrom>[1]> = {},
): Parameters<typeof resolveResumeFrom>[1] => ({
	executor: "claude",
	env: { [RESUME_RETAKE_FLAG]: "on" },
	now: NOW,
	transcriptFor: (sid: string) => (sid === "lane" ? warm : null),
	...over,
});

describe("W622 retake knob fences", () => {
	test("policy off (the default) → fresh, doctrine named", () => {
		const d = resolveResumeFrom("lane", {
			executor: "claude",
			env: {},
			now: NOW,
			transcriptFor: () => warm,
		});
		expect(d.mode).toBe("fresh");
		if (d.mode === "fresh")
			expect(d.why).toContain("doctrine: fresh lane + capsule");
	});

	test("no --resume-from requested → fresh (knob untouched)", () => {
		const d = resolveResumeFrom(undefined, opts());
		expect(d.mode).toBe("fresh");
		if (d.mode === "fresh") expect(d.why).toBe("no --resume-from requested");
	});

	test("non-claude executor → fresh", () => {
		const d = resolveResumeFrom("lane", opts({ executor: "codex" }));
		expect(d.mode).toBe("fresh");
		if (d.mode === "fresh")
			expect(d.why).toContain("no verified resume grammar");
	});

	test("no transcript → fresh", () => {
		const d = resolveResumeFrom("ghost", opts());
		expect(d.mode).toBe("fresh");
		if (d.mode === "fresh") expect(d.why).toContain("no transcript found");
	});

	test("stale transcript (past the fence) → fresh, age named", () => {
		const d = resolveResumeFrom("lane", {
			...opts(),
			transcriptFor: () => stale,
		});
		expect(d.mode).toBe("fresh");
		if (d.mode === "fresh") expect(d.why).toContain("transcript stale");
	});

	test("warm transcript → resume with the claude adapter's forkArgs", () => {
		const d = resolveResumeFrom("lane", opts());
		expect(d.mode).toBe("resume");
		if (d.mode === "resume") {
			expect(d.sessionUuid).toBe("warm");
			expect(d.forkArgs).toEqual(["--resume", "warm", "--fork-session"]);
		}
	});

	test("retakeTtlMin default 10, env-overridable", () => {
		expect(retakeTtlMin({})).toBe(10);
		expect(retakeTtlMin({ SUSPENDERS_RETAKE_TTL_MIN: "3" })).toBe(3);
	});
});

describe("W622 dispatch helpers", () => {
	test("decisionFor fires only when the request matches the claim's sid", () => {
		expect(
			decisionFor("other", "lane", "claude", opts().env, {
				transcriptFor: (sid) => (sid === "lane" ? warm : null),
				now: NOW,
			}).mode,
		).toBe("fresh");
		expect(
			decisionFor("lane", "lane", "claude", opts().env, {
				transcriptFor: (sid) => (sid === "lane" ? warm : null),
				now: NOW,
			}).mode,
		).toBe("resume");
	});
});

describe("W622 brief disclosure", () => {
	test("honored resume is disclosed; refused stays out of the brief", () => {
		const on = resolveResumeFrom("lane", opts());
		expect(resumeBriefLine(on).length).toBe(1);
		const off = resolveResumeFrom("ghost", opts());
		expect(resumeBriefLine(off).length).toBe(0);
	});
});
