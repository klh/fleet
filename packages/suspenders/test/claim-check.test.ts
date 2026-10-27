// test/claim-check.test.ts — W833: the done-gate claim-check probe. Covered:
// transcript event extraction (claims from assistant prose only, run sums
// from tool outputs), the before-the-claim ordering rule (no run, failed
// run, run after the claim), the stale-file rule (mtime after the last
// passing run), diff erosion (deleted tests with the move exemption,
// focused/expected-failure gates, loosened assertions), fail-open paths,
// and the disable knob.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CLAIM_CHECK_GRACE_MS,
	CLAIM_CHECK_SCAN_BYTES,
	claimCheckVerdict,
	isClaim,
	isPassingRun,
	runCounts,
	scanClosingDiff,
	testAffectingPath,
	transcriptEventsFromText,
	transcriptWindow,
} from "../hooks/lib/gates/claim-check.ts";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const lineOf = (o: Record<string, unknown>): string => JSON.stringify(o);
const assistantSay = (text: string, min: number): string =>
	lineOf({
		type: "assistant",
		timestamp: iso(min),
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
let tid = 0;
// a paired bun-test call: assistant tool_use + its result — the real
// transcript shape; run events need this pairing (W917 origin gate)
const toolUse = (command: string, min: number): string => {
	const id = `toolu_w917_${++tid}`;
	return lineOf({
		type: "assistant",
		timestamp: iso(min),
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id, input: { command } }],
		},
	});
};
const toolResult = (text: string, min: number): string =>
	[
		toolUse("bun test", min - 1),
		lineOf({
			type: "user",
			timestamp: iso(min),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `toolu_w917_${tid}`,
						content: text,
					},
				],
			},
		}),
	].join("\n");
const toolStdout = (text: string, min: number): string =>
	[
		toolUse("bun test", min - 1),
		lineOf({
			type: "user",
			timestamp: iso(min),
			toolUseResult: { stdout: text },
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `toolu_w917_${tid}`,
						content: "",
					},
				],
			},
		}),
	].join("\n");

// an UNPAIRED result — relayed noise with no assistant call behind it
const orphanResult = (text: string, id: string, min: number): string =>
	lineOf({
		type: "user",
		timestamp: iso(min),
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: id, content: text }],
		},
	});

const codexCall = (command: string, min: number): string => {
	const id = `call_codex_${++tid}`;
	return lineOf({
		type: "response_item",
		timestamp: iso(min),
		payload: {
			type: "custom_tool_call",
			name: "exec",
			call_id: id,
			input: `const r=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"});text(r.output)`,
		},
	});
};
const codexResult = (text: string, min: number): string =>
	lineOf({
		type: "response_item",
		timestamp: iso(min),
		payload: {
			type: "custom_tool_call_output",
			call_id: `call_codex_${tid}`,
			output: [
				{ type: "input_text", text: "Script completed\nOutput:\n" },
				{ type: "input_text", text },
			],
		},
	});
const codexSay = (text: string, min: number): string =>
	lineOf({
		type: "response_item",
		timestamp: iso(min),
		payload: {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text }],
		},
	});

const v = (o: Partial<Parameters<typeof claimCheckVerdict>[0]> = {}) =>
	claimCheckVerdict({ client: "claude", paths: [], diffText: "", ...o });

describe("claim and run detection", () => {
	test("claims match assistant-style prose, negations void", () => {
		expect(isClaim("landed; all tests pass in 4.2s")).toBe(true);
		expect(isClaim("suite is green after the fix")).toBe(true);
		expect(isClaim("no tests pass yet — writing fixtures")).toBe(false);
		expect(isClaim("the suite is red, investigating")).toBe(false);
		expect(isClaim("refactored the harness")).toBe(false);
	});

	test("runCounts reads bun, jest and vitest summaries", () => {
		expect(runCounts(" 42 pass\n  0 fail\n 1 skip")).toEqual({
			pass: 42,
			fail: 0,
		});
		expect(runCounts("Tests: 2 passed, 5 failed, 9 total")).toEqual({
			pass: 2,
			fail: 5,
		});
		expect(runCounts("Ran 12 checks")).toBeNull();
		expect(isPassingRun(" 42 pass\n  0 fail")).toBe(true);
		expect(isPassingRun(" 40 pass\n  2 fail")).toBe(false);
	});

	test("claims come only from assistant text; runs only from tool outputs", () => {
		const events = transcriptEventsFromText(
			[
				assistantSay("all tests pass, landing", -2),
				lineOf({
					type: "user",
					timestamp: iso(-3),
					message: {
						role: "user",
						content: [{ type: "text", text: "all tests pass" }],
					},
				}),
				toolResult(" 4 pass\n 0 fail", -10),
				toolStdout(" 5 pass\n 0 fail", -9),
			].join("\n"),
			"claude",
		);
		expect(events.claims).toHaveLength(1);
		expect(events.claims[0]?.ts).toBe(Date.parse(iso(-2)));
		expect(events.runs).toHaveLength(2);
	});

	test("untimestamped events drop (fail-open)", () => {
		const events = transcriptEventsFromText(
			lineOf({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "all tests pass" }],
				},
			}),
			"claude",
		);
		expect(events.claims).toHaveLength(0);
	});
});

describe("ordering: the pass must predate the claim", () => {
	test("a prior item's claim is outside the current claim window", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass for the previous item", -20),
				toolResult(" 2 pass\n 1 fail", -19),
			].join("\n"),
			claimStartedAt: Date.parse(iso(-10)),
		});
		expect(r.ok).toBe(true);
	});

	test("a prior item's passing run cannot support a current claim", () => {
		const r = v({
			transcriptText: [
				toolResult(" 7 pass\n 0 fail", -20),
				assistantSay("all tests pass for this item", -2),
			].join("\n"),
			claimStartedAt: Date.parse(iso(-10)),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found");
	});

	test("a fresh passing run after re-take is not held hostage by the old claim", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass before the old claim was released", -20),
				toolResult(" 13 pass\n 0 fail", -2),
			].join("\n"),
			claimStartedAt: Date.parse(iso(-10)),
		});
		expect(r.ok).toBe(true);
	});

	test("passing run before the claim closes clean", () => {
		const r = v({
			transcriptText: [
				toolResult(" 4 pass\n 0 fail", -10),
				assistantSay("all tests pass", -2),
			].join("\n"),
		});
		expect(r.ok).toBe(true);
	});

	test("claim with no run refuses", () => {
		const r = v({ transcriptText: assistantSay("all tests pass", -2) });
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found in the transcript");
	});

	test("last run before the claim failed refuses", () => {
		const r = v({
			transcriptText: [
				toolResult(" 2 pass\n 2 fail", -10),
				assistantSay("suite is green", -2),
			].join("\n"),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("failed (2 pass / 2 fail)");
	});

	test("a passing run after closure cannot validate the claim", () => {
		const r = v({
			transcriptText: [
				assistantSay("suite is green", -2),
				toolResult(" 4 pass\n 0 fail", 5),
			].join("\n"),
			now: T0,
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("after the claim");
	});

	test("a later own passing run corrects an unsupported interim claim at closure", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass", -10),
				toolResult(" 7 pass\n 0 fail", -5),
			].join("\n"),
		});
		expect(r.ok).toBe(true);
	});

	test("a later failed run does not validate an earlier unsupported claim", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass", -10),
				toolResult(" 2 pass\n 1 fail", -5),
			].join("\n"),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("failed (2 pass / 1 fail)");
	});

	test("a failed run after a pass invalidates the final claim", () => {
		const r = v({
			transcriptText: [
				toolResult(" 7 pass\n 0 fail", -10),
				toolResult(" 2 pass\n 1 fail", -5),
				assistantSay("all tests pass", -2),
			].join("\n"),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("failed (2 pass / 1 fail)");
	});
});

describe("origin: foreign noise never counts (W917)", () => {
	test("Codex own exec_command test output corrects an interim claim", () => {
		const transcriptText = [
			codexSay("681 tests pass", -10),
			codexCall("bun test packages/buckle/test/gov-metrics.test.ts", -6),
			codexResult(" 7 pass\n 0 fail\nRan 7 tests across 1 file.", -5),
		].join("\n");
		const events = transcriptEventsFromText(transcriptText, "codex");
		expect(events.claims).toHaveLength(1);
		expect(events.runs).toHaveLength(1);
		const r = v({ transcriptText, client: "codex" });
		expect(r.ok).toBe(true);
	});

	test("Codex relayed counts from a non-test command do not count", () => {
		const r = v({
			transcriptText: [
				codexSay("all tests pass", -10),
				codexCall("coord inbox --as sid", -6),
				codexResult(" 681 pass\n 0 fail", -5),
			].join("\n"),
			client: "codex",
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found");
	});

	test("Codex output without its initiating call is foreign", () => {
		const r = v({
			transcriptText: [
				codexSay("all tests pass", -10),
				codexResult(" 681 pass\n 0 fail", -5),
			].join("\n"),
			client: "codex",
		});
		expect(r.ok).toBe(false);
	});
	test("foreign relayed pass after a false claim cannot correct it", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass", -10),
				orphanResult(" 681 pass\n 0 fail", "foreign_report", -5),
			].join("\n"),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found");
	});
	test("relayed counts in an unpaired tool_result never satisfy a claim", () => {
		const r = v({
			transcriptText: [
				orphanResult(" 27 pass\n 2 fail", "foreign_dump_1", -10),
				assistantSay("all tests pass", -2),
			].join("\n"),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found in the transcript");
	});

	test("WS-inbox user text with pass/fail sums yields no runs and no claims", () => {
		const events = transcriptEventsFromText(
			lineOf({
				type: "user",
				timestamp: iso(-4),
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "WS INBOX +2:\n  lanes live 5/7 — relayed suite line reads 27 pass / 2 fail",
						},
					],
				},
			}),
			"claude",
		);
		expect(events.runs).toHaveLength(0);
		expect(events.claims).toHaveLength(0);
	});

	test("a result of a non-test command is not a run", () => {
		const events = transcriptEventsFromText(
			[
				toolUse("eza -la", -11),
				lineOf({
					type: "user",
					timestamp: iso(-10),
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: `toolu_w917_${tid}`,
								content: " 5 pass\n 0 fail",
							},
						],
					},
				}),
			].join("\n"),
			"claude",
		);
		expect(events.runs).toHaveLength(0);
	});

	test("own test-run output counts beside foreign noise", () => {
		const r = v({
			transcriptText: [
				toolResult(" 20 pass\n 0 fail", -10),
				orphanResult(" 27 pass\n 2 fail", "foreign_dump_2", -9),
				assistantSay("all tests pass", -2),
			].join("\n"),
		});
		expect(r.ok).toBe(true);
	});
});

describe("capsule claims", () => {
	test("a capsule from a released claim cannot block a re-taken item", () => {
		const r = v({
			capsuleDone: "all tests pass before the old claim was released",
			capsuleTs: Date.parse(iso(-20)),
			claimStartedAt: Date.parse(iso(-10)),
		});
		expect(r.ok).toBe(true);
	});
	test("a final capsule claim remains refused until its own passing run", () => {
		const r = v({
			transcriptText: [
				assistantSay("all tests pass", -10),
				toolResult(" 7 pass\n 0 fail", 5),
			].join("\n"),
			capsuleDone: "all tests pass",
			capsuleTs: Date.parse(iso(-2)),
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("after the claim");
	});
	test("capsule claim with no run refuses", () => {
		const r = v({
			transcriptText: "",
			capsuleDone: "all tests green, landed",
			now: T0,
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("no test run found");
	});

	test("capsule claim backed by an earlier passing run closes", () => {
		const r = v({
			transcriptText: toolResult(" 4 pass\n 0 fail", -10),
			capsuleDone: "all tests green, landed",
			capsuleTs: Date.parse(iso(-5)),
		});
		expect(r.ok).toBe(true);
	});
});

describe("stale evidence: test-affecting files after the pass", () => {
	const DIR = mkdtempSync(join(process.cwd(), ".tmp-w833-cc-"));
	const transcript = [
		toolResult(" 4 pass\n 0 fail", -10),
		assistantSay("all tests pass", -2),
	].join("\n");
	const setMtime = (name: string, min: number): void => {
		const at = new Date(T0 + min * 60_000);
		utimesSync(join(DIR, name), at, at);
	};
	mkdirSync(DIR, { recursive: true });
	writeFileSync(join(DIR, "calc.ts"), "export const one = 1;\n");
	writeFileSync(join(DIR, "notes.md"), "# notes\n");

	test("file touched after the run refuses, naming the path", () => {
		setMtime("calc.ts", -5); // run at -10, grace 2min → stale at -8
		const r = v({
			transcriptText: transcript,
			paths: ["calc.ts"],
			statRoot: DIR,
		});
		expect(r.ok).toBe(false);
		expect(r.why).toContain("changed after the last passing run");
		expect(r.why).toContain("calc.ts");
	});

	test("file mtime inside the window and prose docs pass", () => {
		setMtime("calc.ts", -11);
		setMtime("notes.md", 3);
		expect(
			v({
				transcriptText: transcript,
				paths: ["calc.ts", "notes.md"],
				statRoot: DIR,
			}).ok,
		).toBe(true);
	});

	afterAll(() => rmSync(DIR, { recursive: true, force: true }));
});

describe("diff erosion", () => {
	const DIFF_DELETED = [
		"diff --git a/src/calc.test.ts b/src/calc.test.ts",
		"--- a/src/calc.test.ts",
		"+++ b/src/calc.test.ts",
		"@@ -3,3 +3,0 @@",
		'-	test("legacy case", () => {',
		"-		expect(add(1, 2)).toBe(3);",
		"-	});",
	].join("\n");

	test("a deleted test call refuses; the verdict names it", () => {
		const hits = scanClosingDiff(DIFF_DELETED);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.kind).toBe("deleted-test");
		expect(hits[0]?.path).toBe("src/calc.test.ts");
		const r = v({ diffText: DIFF_DELETED });
		expect(r.ok).toBe(false);
		expect(r.why).toContain("erodes the test suite");
	});

	test("a moved test (name re-added) is exempt", () => {
		const diff = [
			DIFF_DELETED,
			"diff --git a/src/calc2.test.ts b/src/calc2.test.ts",
			"--- /dev/null",
			"+++ b/src/calc2.test.ts",
			"@@ -0,0 +1,1 @@",
			'+	test("legacy case", () => {});',
		].join("\n");
		expect(scanClosingDiff(diff)).toEqual([]);
	});

	test("a same-hunk, one-for-one test rewrite preserves coverage", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -3,4 +3,4 @@",
			'-\ttest("legacy direct route", () => {',
			"-\t\texpect(route()).toBe('direct');",
			'+\ttest("gateway route", () => {',
			"+\t\texpect(route()).toBe('gateway');",
		].join("\n");
		expect(scanClosingDiff(diff)).toEqual([]);
	});

	test("one replacement cannot excuse two removed tests", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -3,6 +3,4 @@",
			'-\ttest("legacy direct route", () => {',
			'-\ttest("legacy error route", () => {',
			'+\ttest("gateway route", () => {',
		].join("\n");
		expect(scanClosingDiff(diff).map((hit) => hit.kind)).toEqual([
			"deleted-test",
		]);
	});

	test("a vacuous replacement cannot excuse a substantive deleted test", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -3,4 +3,4 @@",
			'-\ttest("legacy direct route", () => {',
			"-\t\texpect(route()).toBe('direct');",
			'+\ttest("gateway route", () => {',
			"+\t\texpect(true).toBe(true);",
		].join("\n");
		expect(scanClosingDiff(diff).map((hit) => hit.kind)).toContain(
			"deleted-test",
		);
	});

	test("a new test with fewer assertions cannot excuse a deleted test", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -3,4 +3,3 @@",
			'-\ttest("legacy direct route", () => {',
			"-\t\texpect(route()).toBe('direct');",
			'+\ttest("gateway route", () => {',
		].join("\n");
		expect(scanClosingDiff(diff).map((hit) => hit.kind)).toContain(
			"deleted-test",
		);
	});

	test("a replacement in a different hunk cannot excuse deletion", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -3,1 +3,0 @@",
			'-\ttest("legacy direct route", () => {',
			"@@ -40,0 +39,1 @@",
			'+\ttest("unrelated new route", () => {',
		].join("\n");
		expect(scanClosingDiff(diff).map((hit) => hit.kind)).toEqual([
			"deleted-test",
		]);
	});

	test("exact null assertion is not a loosened assertion", () => {
		const diff = [
			"diff --git a/src/route.test.ts b/src/route.test.ts",
			"--- a/src/route.test.ts",
			"+++ b/src/route.test.ts",
			"@@ -7,2 +7,2 @@",
			"-\t\texpect(route()).toBe('direct');",
			"+\t\texpect(route()).toBeNull();",
		].join("\n");
		expect(scanClosingDiff(diff)).toEqual([]);
	});

	test("focused and expected-failure gates refuse", () => {
		// fixtures assemble gate vocabulary from parts so this file's own
		// closing diffs never trip the scans they test (W511/W833 doctrine)
		const xfailCall = ["+	test.fai", 'ling("flaky race", () => {});'].join("");
		const focusCall = ["+	f", 'it("focused", () => {});'].join("");
		for (const added of [xfailCall, focusCall]) {
			const hits = scanClosingDiff(
				[
					"diff --git a/src/f.test.ts b/src/f.test.ts",
					"--- a/src/f.test.ts",
					"+++ b/src/f.test.ts",
					"@@ -0,0 +1,1 @@",
					added,
				].join("\n"),
			);
			const xfailKind = ["xfai", "l-gate"].join("");
			expect(hits.map((h) => h.kind)).toEqual([xfailKind]);
		}
	});

	test("strict swapped for loose assertions refuses", () => {
		const diff = [
			"diff --git a/src/sum.test.ts b/src/sum.test.ts",
			"--- a/src/sum.test.ts",
			"+++ b/src/sum.test.ts",
			"@@ -7,2 +7,2 @@",
			"-		expect(total).toBe(7);",
			"+		expect(total).toBeTruthy();",
		].join("\n");
		expect(scanClosingDiff(diff).map((h) => h.kind)).toEqual([
			"loosened-assertion",
		]);
	});

	test("clean additions and non-test files pass", () => {
		expect(
			scanClosingDiff(
				[
					"diff --git a/src/new.test.ts b/src/new.test.ts",
					"--- /dev/null",
					"+++ b/src/new.test.ts",
					"@@ -0,0 +1,3 @@",
					'+	test("adds", () => {',
					"+		expect(add(1, 2)).toBe(3);",
					"+	});",
				].join("\n"),
			),
		).toEqual([]);
		expect(
			scanClosingDiff(
				[
					"diff --git a/src/util.ts b/src/util.ts",
					"--- a/src/util.ts",
					"+++ b/src/util.ts",
					"@@ -7,2 +7,2 @@",
					"-		assert(total === 7);",
					"+		assert(Boolean(total));",
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("missing evidence and mandatory enforcement", () => {
	test("missing transcript and no capsule claim → ok", () => {
		expect(v({ transcriptPath: "/nonexistent/transcript.jsonl" }).ok).toBe(
			true,
		);
	});

	test("the former environment opt-out cannot disable evidence verification", () => {
		const previous = process.env.SUSPENDERS_CLAIM_CHECK;
		process.env.SUSPENDERS_CLAIM_CHECK = "0";
		try {
			const r = v({ transcriptText: assistantSay("suite is green", -2) });
			expect(r.ok).toBe(false);
			expect(r.why).not.toContain("Escape hatch");
		} finally {
			if (previous === undefined) delete process.env.SUSPENDERS_CLAIM_CHECK;
			else process.env.SUSPENDERS_CLAIM_CHECK = previous;
		}
	});

	test("constants hold the calibration", () => {
		expect(CLAIM_CHECK_SCAN_BYTES).toBe(8 * 1024 * 1024);
		expect(CLAIM_CHECK_GRACE_MS).toBe(120_000);
	});

	test("test-affecting path filter", () => {
		expect(testAffectingPath("hooks/lib/x.ts")).toBe(true);
		expect(testAffectingPath("docs/notes.md")).toBe(false);
		expect(testAffectingPath(".fleet/brief-w833.md")).toBe(false);
	});
});

describe("transcriptWindow", () => {
	test("bounded tail aligns to a line start; missing file fails open", () => {
		const DIR = mkdtempSync(join(process.cwd(), ".tmp-w833-cc-win-"));
		const f = join(DIR, "t.jsonl");
		writeFileSync(
			f,
			[
				`${lineOf({ n: 1 })}${"x".repeat(80)}`,
				assistantSay("mid", 0),
				toolResult(" 1 pass\n 0 fail", 1),
			].join("\n"),
		);
		const w = transcriptWindow(f, 64);
		expect(w).not.toContain('"n":1');
		expect(w).toContain(" 1 pass");
		expect(transcriptWindow(join(DIR, "absent.jsonl"))).toBeNull();
		rmSync(DIR, { recursive: true, force: true });
	});
});

afterAll(() => {
	for (const d of [".tmp-w833-cc-", ".tmp-w833-cc-win-"])
		rmSync(join(process.cwd(), d), { recursive: true, force: true });
});
