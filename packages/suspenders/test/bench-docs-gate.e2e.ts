// test/bench-docs-gate.test.ts — W951: the bench-docs done-gate. Covered:
// the bench-shape detector, the refusal (naming only the missing ledgers),
// the pass when both ledgers ride the path window, and the disable knob.
import { expect, test } from "@playwright/test";
import {
	BENCH_DOC_PATHS,
	benchDocsVerdict,
	isBenchItem,
} from "../hooks/lib/gates/bench-docs-gate.ts";

test.describe("bench-shape detector", () => {
	test("bench/benchmark/A-B in title or description is bench-shaped", () => {
		expect(isBenchItem("bench: LLM knowledge banking")).toBe(true);
		expect(isBenchItem("W949 bench: LLM knowledge banking A/B")).toBe(true);
		expect(isBenchItem("plain item", "runs an a/b comparison")).toBe(true);
		expect(isBenchItem(null, null)).toBe(false);
		expect(isBenchItem("wire the sensor array")).toBe(false);
	});

	test("constants hold the ledger paths", () => {
		expect(BENCH_DOC_PATHS).toEqual(["benchmarks.md", "doesnt_work.md"]);
	});
});

test.describe("verdict", () => {
	const T = "bench: A/B retrieval verdict";

	test("refuses while ledgers are absent from the path window", () => {
		const v = benchDocsVerdict({ title: T, paths: ["src/bench-run.ts"] });
		expect(v.ok).toBe(false);
		expect(v.missing).toEqual(["benchmarks.md", "doesnt_work.md"]);
		expect(v.why).toContain("bench-docs (W951)");
		expect(v.why).toContain("SUSPENDERS_DONE_DOCS=0");
	});

	test("names only the ledger that is actually missing", () => {
		const v = benchDocsVerdict({
			title: T,
			paths: ["benchmarks.md", "src/x.ts"],
		});
		expect(v.ok).toBe(false);
		expect(v.missing).toEqual(["doesnt_work.md"]);
	});

	test("passes when both ledgers ride the window", () => {
		const v = benchDocsVerdict({
			title: T,
			paths: ["bench-run.ts", "benchmarks.md", "doesnt_work.md"],
		});
		expect(v.ok).toBe(true);
	});

	test("non-bench items and the disable knob pass", () => {
		expect(
			benchDocsVerdict({ title: "wire the sensor array", paths: [] }).ok,
		).toBe(true);
		expect(benchDocsVerdict({ title: T, paths: [], disabled: true }).ok).toBe(
			true,
		);
		const prev = process.env.SUSPENDERS_DONE_DOCS;
		process.env.SUSPENDERS_DONE_DOCS = "0";
		try {
			expect(benchDocsVerdict({ title: T, paths: [] }).ok).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_DONE_DOCS;
			else process.env.SUSPENDERS_DONE_DOCS = prev;
		}
	});
});
