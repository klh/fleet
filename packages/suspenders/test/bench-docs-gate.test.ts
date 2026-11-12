// test/bench-docs-gate.test.ts — W951: the bench-docs done-gate. Covered:
// the bench-shape detector, the refusal (naming only the missing ledgers),
// the pass when a full ledger pair rides the path window — canonical
// (W2990.12) or legacy root — and the disable knob.
import { describe, expect, test } from "bun:test";
import {
	BENCH_DOC_PAIRS,
	BENCH_DOC_PATHS,
	CANONICAL_BENCH_DOC_PATHS,
	benchDocsVerdict,
	isBenchItem,
} from "../hooks/lib/gates/bench-docs-gate.ts";

describe("bench-shape detector", () => {
	test("bench/benchmark/A-B in title or description is bench-shaped", () => {
		expect(isBenchItem("bench: LLM knowledge banking")).toBe(true);
		expect(isBenchItem("W949 bench: LLM knowledge banking A/B")).toBe(true);
		expect(isBenchItem("plain item", "runs an a/b comparison")).toBe(true);
		expect(isBenchItem(null, null)).toBe(false);
		expect(isBenchItem("wire the sensor array")).toBe(false);
	});

	test("constants hold the ledger paths", () => {
		expect(BENCH_DOC_PATHS).toEqual(["benchmarks.md", "doesnt_work.md"]);
		expect(CANONICAL_BENCH_DOC_PATHS).toEqual([
			"benchmarks/benchmark.md",
			"benchmarks/benchmarks.json5",
		]);
		expect(BENCH_DOC_PAIRS).toEqual([
			CANONICAL_BENCH_DOC_PATHS,
			BENCH_DOC_PATHS,
		]);
	});
});

describe("verdict", () => {
	const T = "bench: A/B retrieval verdict";

	test("refuses while no accepted pair rides the path window", () => {
		const v = benchDocsVerdict({ title: T, paths: ["src/bench-run.ts"] });
		expect(v.ok).toBe(false);
		expect(v.missing).toEqual(CANONICAL_BENCH_DOC_PATHS);
		expect(v.why).toContain("bench-docs (W951)");
		expect(v.why).toContain("benchmarks/benchmark.md");
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

	test("passes when the W2990.12 canonical pair rides the window", () => {
		const v = benchDocsVerdict({
			title: T,
			paths: ["bench-run.ts", ...CANONICAL_BENCH_DOC_PATHS],
		});
		expect(v.ok).toBe(true);
	});

	test("mixed-window coverage across pairs satisfies nothing", () => {
		const v = benchDocsVerdict({
			title: T,
			paths: ["benchmarks/benchmark.md", "doesnt_work.md"],
		});
		expect(v.ok).toBe(false);
	});

	test("refusal reports the closest pair, canonical on ties", () => {
		const none = benchDocsVerdict({ title: T, paths: [] });
		expect(none.ok).toBe(false);
		expect(none.missing).toEqual(CANONICAL_BENCH_DOC_PATHS);
		const legacyOnly = benchDocsVerdict({
			title: T,
			paths: ["benchmarks.md"],
		});
		expect(legacyOnly.missing).toEqual(["doesnt_work.md"]);
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
