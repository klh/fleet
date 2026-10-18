// review-bench.test.ts — W792: pure tests for the review-arena harness.
// No live LLM: generators, diff engine, parsers, matcher/score, seal refusals.
import { describe, expect, test } from "bun:test";
import {
	DEFECT_CLASSES,
	type Defect,
	lineOf,
	type ReviewTask,
	unifiedDiff,
} from "./review-core.ts";
import {
	parseFindings,
	parseFix,
	parseTriage,
	parseVerify,
	parseVerdictLine,
} from "./review-parse.ts";
import { matchFindings, scoreOutcome } from "./review-score.ts";
import { assembleReviewTasks, seededTasks } from "./review-set.ts";
import { INCIDENTS, incidentTask } from "./review-incident.ts";

const DEFECT: Defect = {
	id: "d1",
	file: "src/ring.ts",
	line: 7,
	cls: "off-by-one",
	desc: "index wraps past capacity",
};

describe("unifiedDiff/lineOf", () => {
	test("hunk headers, context and +/- lines", () => {
		const a = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10";
		const b = "l1\nl2\nl3\nl4\nX5\nl6\nl7\nl8\nl9\nl10";
		const d = unifiedDiff("src/x.ts", a.split("\n"), b.split("\n"));
		expect(d.startsWith("--- a/src/x.ts")).toBe(true);
		expect(d).toContain("+X5");
	});
	test("lineOf finds 1-based anchor, 0 when absent", () => {
		expect(lineOf("a\nb\nc", "b")).toBe(2);
		expect(lineOf("a\nb\nc", "zzz")).toBe(0);
	});
});
describe("parsers", () => {
	test("parseFindings primary format + fallback", () => {
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
describe("verdict/verify/triage/fix parsers", () => {
	test("parseVerdictLine last-line PASS/FAIL, missing = FAIL", () => {
		expect(parseVerdictLine("stuff\nVERDICT: PASS").verdict).toBe("PASS");
		expect(parseVerdictLine("VERDICT: FAIL - broken").verdict).toBe("FAIL");
		expect(parseVerdictLine("no verdict line").verdict).toBe("FAIL");
	});
	test("parseVerify + parseTriage default unclear/important", () => {
		expect(parseVerify("1: confirmed\n2: refuted\n3: wat", 3)).toEqual([
			"confirmed",
			"refuted",
			"unclear",
		]);
		expect(parseTriage("1: nit\n2: ??", 2)).toEqual(["nit", "important"]);
	});
	test("parseFix fenced block, min length guard", () => {
		expect(parseFix("a\n```ts\nconst x = 1;\nconst y = 2;\n```\nb")).toBe(
			"const x = 1;\nconst y = 2;",
		);
		expect(parseFix("no fence at all")).toBe(null);
	});
});
describe("matchFindings/scoreOutcome", () => {
	const DEF: Defect[] = [
		{ id: "d1", file: "src/ring.ts", line: 7, cls: "off-by-one", desc: "wrap" },
	];
	const FIND = (
		file: string,
		line: number,
		severity: "high" | "medium" | "low" = "high",
	) => ({
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
	test("hit within tolerance counts as recall, not fp", () => {
		const hit = scoreOutcome({
			...BASE,
			defects: DEF,
			findings: [FIND("src/ring.ts", 9)],
		});
		expect(hit.recall).toBe(1);
		expect(hit.fp).toBe(0);
		expect(hit.humanRequired).toBe(1);
	});
	test("wrong file = fp", () => {
		const wrongFile = scoreOutcome({
			...BASE,
			defects: DEF,
			findings: [FIND("src/other.ts", 7)],
		});
		expect(wrongFile.recall).toBe(0);
		expect(wrongFile.fp).toBe(1);
	});
	test("clean task: all findings are noise, PASS is correct", () => {
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
describe("incident tasks", () => {
	test("all 3 incidents produce verifiable ground truth", () => {
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
