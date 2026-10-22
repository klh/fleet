// test/lane-layout.test.ts — W1139.2: the lane layout law. The shared lane
// prefix (system + tools + orientation seed) is cache-critical: churn hazards
// (timestamps, per-lane paths/sids, machine-local homes) refuse at the
// seeding gate, promoted guidance rows carrying them are skipped at
// composition, and retake continuations compose as identical-prefix +
// appended summary — never a re-orientation.
import { describe, expect, test } from "bun:test";
import {
	assertStablePrefix,
	continuationPrompt,
	LAYOUT_LAW_BULLET,
	PREFIX_CHURN_PATTERN,
} from "../scripts/lib/lane-layout.ts";
import {
	continuationPromptFor,
	resumeStartNotes,
} from "../scripts/lib/resume-from.ts";
import { starterInstructionContext } from "../scripts/lib/lane-starter.ts";

describe("lane-layout", () => {
	test("PREFIX_CHURN_PATTERN flags every shared-prefix hazard class", () => {
		for (const hazard of [
			"Deployed 2026-10-22 to all hubs",
			"work in .worktrees/W1139.2",
			"home is /Users/kk", // scrub:allow — pattern-fixture literal
			"lane autow1139-2-p98b319584008df14 continues",
		])
			expect(PREFIX_CHURN_PATTERN.test(hazard)).toBe(true);
	});

	test("fixed orientation text and the layout bullet are churn-free", () => {
		expect(PREFIX_CHURN_PATTERN.test(LAYOUT_LAW_BULLET)).toBe(false);
		expect(PREFIX_CHURN_PATTERN.test(starterInstructionContext())).toBe(false);
		expect(() => assertStablePrefix(starterInstructionContext())).not.toThrow();
	});

	test("assertStablePrefix refuses the seed with the matched hazard", () => {
		expect(() => assertStablePrefix("ok line")).not.toThrow();
		expect(() => assertStablePrefix(`fine\nseeded 2026-10-22, fine`)).toThrow(
			/2026-10-22/,
		);
	});

	test("continuationPrompt appends the summary after an unchanged base", () => {
		const base = "SHARED PREFIX LINE\nsecond line";
		const out = continuationPrompt(base, "progress so far");
		expect(out.startsWith(base)).toBe(true);
		expect(out).toContain("CONTINUATION");
		expect(out.endsWith("SUMMARY: progress so far")).toBe(true);
	});

	test("continuationPromptFor rides only the honored-resume path", () => {
		const cold = "COLD BRIEF";
		const resume = {
			mode: "resume" as const,
			sid: "sid-x",
			forkArgs: ["--resume", "x", "--fork-session"],
		};
		const fresh = { mode: "fresh" as const, why: "no --resume-from requested" };
		expect(continuationPromptFor(fresh, cold)).toBe(cold);
		const continued = continuationPromptFor(resume, cold);
		expect(continued.startsWith(starterInstructionContext())).toBe(true);
		expect(continued).toContain("SUMMARY: ");
		expect(continued).toContain("sid-x");
	});

	test("promoted guidance rows carrying churn are skipped at composition", () => {
		const guidance = [
			"Always run qlty before commit",
			"As of 2026-10-22 the fleet runs release fa75",
			"work in .worktrees/<item>",
			"streams over buffers",
		].join("\n");
		const ctx = starterInstructionContext(guidance);
		expect(ctx).toContain("Always run qlty before commit");
		expect(ctx).toContain("streams over buffers");
		expect(ctx).not.toContain("2026-10-22");
		expect(ctx).not.toContain(".worktrees/");
		expect(ctx).toContain("Promoted lane guidance:");
		expect(() => assertStablePrefix(ctx)).not.toThrow;
	});

	test("all-churn guidance drops the whole block, seed stays clean", () => {
		const ctx = starterInstructionContext("seeded 2026-10-22\npath /Users/x"); // scrub:allow — pattern-fixture literal
		expect(ctx).not.toContain("Promoted lane guidance:");
		expect(() => assertStablePrefix(ctx)).not.toThrow();
	});

	test("resumeStartNotes surfaces honored resume and refusal, never silent", () => {
		const seen: string[] = [];
		const orig = console.log;
		console.log = (line: string) => {
			seen.push(line);
		};
		try {
			resumeStartNotes(
				{
					mode: "resume",
					sid: "sid-y",
					forkArgs: ["--resume", "y", "--fork-session"],
				},
				false,
			);
			resumeStartNotes(
				{ mode: "fresh", why: "no transcript found for sid-z" },
				true,
			);
			resumeStartNotes({ mode: "fresh", why: "not requested" }, false);
		} finally {
			console.log = orig;
		}
		expect(seen.length).toBe(2);
		expect(seen[0]).toContain("transcript resume sid-y");
		expect(seen[1]).toContain("--resume-from refused");
	});
});
