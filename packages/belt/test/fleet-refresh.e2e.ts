import { expect, test } from "@playwright/test";
import {
	verdictOf,
	parseMedian,
	parseLoadavg,
	isStalled,
	priorTried,
	type TriedRow,
} from "../bin/fleet-refresh.ts";

test.describe("priorTried", () => {
	const rows: TriedRow[] = [
		{ id: "a/model", verdict: "lose", date: "2026-10-03", note: "slow" },
		{ id: "b/model", verdict: "win", date: "2026-10-03", slot: 8903 },
	];
	test("finds prior verdict by exact id @unit", () => {
		expect(priorTried(rows, "a/model")?.verdict).toBe("lose");
	});
	test("undefined for untried id @unit", () => {
		expect(priorTried(rows, "c/model")).toBeUndefined();
	});
});

test.describe("verdictOf", () => {
	test("win above margin @unit", () => {
		expect(verdictOf(100, 87, 0.05)).toBe("win");
	});
	test("lose below margin @unit", () => {
		expect(verdictOf(68.5, 87.0, 0.05)).toBe("lose");
	});
	test("tie inside margin @unit", () => {
		expect(verdictOf(86.0, 87.0, 0.05)).toBe("tie");
	});
	test("exact margin boundary is tie @unit", () => {
		expect(verdictOf(87.0 * 1.05, 87.0, 0.05)).toBe("tie");
	});
});

test.describe("parseMedian", () => {
	test("parses bench-suite median line @unit", () => {
		expect(
			parseMedian("  median: 68.5 tok/s (logged to benchmarks.jsonl)"),
		).toBe(68.5);
	});
	test("throws on missing median @unit", () => {
		expect(() => parseMedian("no output")).toThrow();
	});
});

test.describe("parseLoadavg", () => {
	test("parses sysctl vm.loadavg triple @unit", () => {
		expect(parseLoadavg("{ 9.68 7.45 7.98 }")).toBe(9.68);
	});
	test("returns -1 on garbage @unit", () => {
		expect(parseLoadavg("none")).toBe(-1);
	});
});

test.describe("isStalled", () => {
	const base = { prevBytes: 1e9, expectedBytes: 22.2e9 };
	test("stalled: flat + >15min + incomplete @unit", () => {
		expect(
			isStalled({ ...base, nowBytes: 1e9, prevTs: 0, nowTs: 20 * 60_000 }),
		).toBe(true);
	});
	test("not stalled while growing @unit", () => {
		expect(
			isStalled({ ...base, nowBytes: 1.1e9, prevTs: 0, nowTs: 90 * 60_000 }),
		).toBe(false);
	});
	test("not stalled inside 15min window @unit", () => {
		expect(
			isStalled({ ...base, nowBytes: 1e9, prevTs: 0, nowTs: 10 * 60_000 }),
		).toBe(false);
	});
	test("not stalled when complete @unit", () => {
		expect(
			isStalled({ ...base, nowBytes: 22.2e9, prevTs: 0, nowTs: 90 * 60_000 }),
		).toBe(false);
	});
});
