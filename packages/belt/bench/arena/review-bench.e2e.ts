// review-bench.test.ts — W792: pure tests for the review-arena harness.
// No live LLM: generators, diff engine, parsers, matcher/score, seal refusals.
import { expect, test } from "@playwright/test";
import { type Defect, lineOf, unifiedDiff } from "./review-core.ts";
import {
	findingIdOf,
	openPriorBlockers,
	parseAcks,
	parseFindings,
	parseFix,
	parseTriage,
	parseVerify,
	parseVerdictLine,
	slugOf,
} from "./review-parse.ts";
import { scoreOutcome } from "./review-score.ts";
import { INCIDENTS, incidentTask } from "./review-incident.ts";

test.describe("unifiedDiff/lineOf", () => {
	test("hunk headers, context and +/- lines @unit", () => {
		const a = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10";
		const b = "l1\nl2\nl3\nl4\nX5\nl6\nl7\nl8\nl9\nl10";
		const d = unifiedDiff("src/x.ts", a.split("\n"), b.split("\n"));
		expect(d.startsWith("--- a/src/x.ts")).toBe(true);
		expect(d).toContain("+X5");
	});
	test("lineOf finds 1-based anchor, 0 when absent @unit", () => {
		expect(lineOf("a\nb\nc", "b")).toBe(2);
		expect(lineOf("a\nb\nc", "zzz")).toBe(0);
	});
});
test.describe("parsers", () => {
	test("parseFindings primary format + fallback @unit", () => {
		const text = [
			"high src/ring.ts:7 — index wraps past capacity",
			"medium src/ring.ts:12 — unused parameter shadows",
			"some text",
			"src/other.ts:3 — suspicious unguarded loop",
		].join("\n");
		const fs = parseFindings(text);
		expect(fs.length).toBe(3);
		expect(fs[0]?.severity).toBe("high");
		expect(fs[0]?.file).toBe("src/ring.ts");
		expect(fs[0]?.line).toBe(7);
		expect(fs[2]?.severity).toBe("medium");
	});
});
test.describe("verdict/verify/triage/fix parsers", () => {
	test("parseVerdictLine last-line PASS/FAIL, missing = FAIL @unit", () => {
		expect(parseVerdictLine("stuff\nVERDICT: PASS").verdict).toBe("PASS");
		expect(parseVerdictLine("VERDICT: FAIL - broken").verdict).toBe("FAIL");
		expect(parseVerdictLine("no verdict line").verdict).toBe("FAIL");
	});
	test("parseVerify + parseTriage default unclear/important @unit", () => {
		expect(parseVerify("1: confirmed\n2: refuted\n3: wat", 3)).toEqual([
			"confirmed",
			"refuted",
			"unclear",
		]);
		expect(parseTriage("1: nit\n2: ??", 2)).toEqual(["nit", "important"]);
	});
	test("parseFix fenced block, min length guard @unit", () => {
		expect(parseFix("a\n```ts\nconst x = 1;\nconst y = 2;\n```\nb")).toBe(
			"const x = 1;\nconst y = 2;",
		);
		expect(parseFix("no fence at all")).toBe(null);
	});
});
test.describe("matchFindings/scoreOutcome", () => {
	const DEF: Defect[] = [
		{ id: "d1", file: "src/ring.ts", line: 7, cls: "off-by-one", desc: "wrap" },
	];
	const FIND = (
		file: string,
		line: number,
		severity: "high" | "medium" | "low" = "high",
	) => ({
		id: null,
		file,
		line,
		severity,
		issue: "issue text long enough for the parser",
	});
	const BASE = {
		arm: "a" as const,
		taskId: "t1",
		src: "seeded",
		roundsToPass: 1,
		verdict: "FAIL" as const,
		tokIn: 10,
		tokOut: 5,
		calls: 1,
		wallMs: 100,
	};
	test("hit within tolerance counts as recall, not fp @unit", () => {
		const hit = scoreOutcome({
			...BASE,
			defects: DEF,
			findings: [FIND("src/ring.ts", 9)],
		});
		expect(hit.recall).toBe(1);
		expect(hit.fp).toBe(0);
		expect(hit.humanRequired).toBe(1);
	});
	test("wrong file = fp @unit", () => {
		const wrongFile = scoreOutcome({
			...BASE,
			defects: DEF,
			findings: [FIND("src/other.ts", 7)],
		});
		expect(wrongFile.recall).toBe(0);
		expect(wrongFile.fp).toBe(1);
	});
	test("found-and-fixed PASS counts as correct outcome @unit", () => {
		const fixed = scoreOutcome({
			...BASE,
			defects: DEF,
			findings: [FIND("src/ring.ts", 9)],
			verdict: "PASS",
		});
		expect(fixed.verdictCorrect).toBe(true);
	});
	test("clean task: all findings are noise, PASS is correct @unit", () => {
		const clean = scoreOutcome({
			...BASE,
			verdict: "PASS" as const,
			defects: [],
			findings: [FIND("src/other.ts", 7)],
		});
		expect(clean.humanNoise).toBe(1);
		expect(clean.verdictCorrect).toBe(true);
	});
});
test.describe("incident tasks", () => {
	test("all 3 incidents produce verifiable ground truth @unit", () => {
		expect(INCIDENTS.length).toBe(3);
		for (const inc of INCIDENTS) {
			const t = incidentTask(inc);
			expect(t.id.startsWith("inc-")).toBe(true);
			expect(t.src).toBe("incident");
			expect(t.diff.length).toBeGreaterThan(50);
			expect(t.defects.length).toBeGreaterThan(0);
			expect(t.files?.buggy).toBeDefined();
		}
	});
});
test.describe("W832 finding IDs + acks", () => {
	test("parseFindings reads ID-prefixed lines; legacy lines stay parseable @unit", () => {
		const text = [
			"B1-loop-bound: high: src/ring.ts:7 — index wraps past capacity",
			"- **n2-shadow: note: src/ring.ts:12 — unused parameter shadows**",
			"some prose line",
			"high: src/other.ts:3 — legacy line without an ID parses too",
		].join("\n");
		const fs = parseFindings(text);
		expect(fs.length).toBe(3);
		expect(fs[0]?.id).toBe("B1-loop-bound");
		expect(fs[0]?.severity).toBe("high");
		expect(fs[1]?.id).toBe("n2-shadow");
		expect(fs[1]?.severity).toBe("low"); // note alias
		expect(fs[2]?.id).toBe(null);
	});
	test("parseAcks: canonical three + drift aliases, unknown → still-open @unit", () => {
		const text = [
			"B1-loop: fixed — re-ran the ring tests",
			"b2-wrap: STILL OPEN — loop overruns at cap",
			"N3-x: unverifiable",
			"B4-y: resolved — claimed done, not an explicit fixed",
			"B1-loop: fixed — duplicate line ignored (first wins)",
		].join("\n");
		const acks = parseAcks(text);
		expect(acks.length).toBe(4);
		expect(acks[0]?.status).toBe("fixed");
		expect(acks[1]?.status).toBe("still-open");
		expect(acks[2]?.status).toBe("not-verifiable");
		expect(acks[3]?.status).toBe("still-open");
	});
	test("openPriorBlockers: only explicit fixed closes; missing ack = open; notes never block @unit", () => {
		const acks = parseAcks(
			"B1-a: fixed — re-ran\nB2-b: still-open — re-ran\nN1-c: still-open — noted",
		);
		expect(
			openPriorBlockers(["B1-a", "b2-b", "B3-missing", "N1-c"], acks),
		).toEqual(["b2-b", "B3-missing"]);
	});
	test("findingIdOf + slugOf synthesize stable IDs @unit", () => {
		expect(slugOf("Index wraps — past capacity!")).toBe("index-wraps-past");
		expect(slugOf("  ...")).toBe("finding");
		expect(findingIdOf(2, true, "Index wraps past capacity")).toBe(
			"B2-index-wraps-past",
		);
		expect(findingIdOf(1, false, "unused param")).toBe("N1-unused-param");
		expect(findingIdOf(3, true, "wrap", 2)).toBe("B3-wrap-2");
	});
});
test.describe("W832 verdict contract", () => {
	const DEF: Defect[] = [
		{ id: "d1", file: "src/ring.ts", line: 7, cls: "off-by-one", desc: "wrap" },
	];
	const FIND2 = (id: string | null) => ({
		id,
		file: "src/ring.ts",
		line: 9,
		severity: "high" as const,
		issue: "issue text long enough for the parser",
	});
	const BASE = {
		arm: "b" as const,
		taskId: "t1",
		src: "seeded",
		defects: DEF,
		findings: [FIND2("B1-wrap")],
		roundsToPass: 2,
		tokIn: 10,
		tokOut: 5,
		calls: 3,
		wallMs: 100,
	};
	test("PASS over an open prior blocker is an incorrect verdict @unit", () => {
		const bad = scoreOutcome({
			...BASE,
			verdict: "PASS",
			openBlockers: ["B1-wrap"],
		});
		expect(bad.verdictCorrect).toBe(false);
		expect(bad.openBlockers).toEqual(["B1-wrap"]);
		const good = scoreOutcome({ ...BASE, verdict: "PASS", openBlockers: [] });
		expect(good.verdictCorrect).toBe(true);
	});
	test("FAIL is always correct on defect tasks, blockers open or not @unit", () => {
		const f1 = scoreOutcome({
			...BASE,
			verdict: "FAIL",
			openBlockers: ["B1-wrap"],
		});
		expect(f1.verdictCorrect).toBe(true);
	});
	test("clean task: PASS correct only with zero open blockers @unit", () => {
		const clean = scoreOutcome({
			...BASE,
			src: "clean",
			defects: [],
			findings: [],
			verdict: "PASS",
			openBlockers: ["B1-leftover"],
		});
		expect(clean.verdictCorrect).toBe(false);
	});
});
