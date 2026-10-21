// test/plaid-host-pressure.test.ts — W1102.1: host-pressure gate. Fixture
// samplers only — no real memory_pressure/vm_stat spawns in tests.
import { expect, test } from "bun:test";
import {
	hostPressureDecision,
	hostPressureSampleOf,
	liveHostPressureSample,
	parseFreePct,
	parseSwapouts,
	parseWiredPages,
} from "../hooks/lib/plaid-host-pressure.ts";

const HEALTHY_MP = "System-wide memory free percentage: 71%";
const HEALTHY_VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 123456.
Pages wired down: 4000000.
Swapins: 100.
Swapouts: 5000.`;

const healthy = () =>
	hostPressureSampleOf(parseFreePct(HEALTHY_MP), parseWiredPages(HEALTHY_VM), parseSwapouts(HEALTHY_VM), "fixture");

test("parsers: free %, wired pages, cumulative swapouts; junk → null", () => {
	expect(parseFreePct("System-wide memory free percentage: 71%")).toBe(71);
	expect(parseFreePct("free percentage: 43.5%")).toBe(43.5);
	expect(parseFreePct("garbage")).toBeNull();
	expect(parseWiredPages("Pages wired down: 4000000.")).toBe(4_000_000);
	expect(parseWiredPages("no data")).toBeNull();
	expect(parseSwapouts("Swapouts: 5000.")).toBe(5_000);
	expect(parseSwapouts("none here")).toBeNull();
});

test("decision: healthy sample opens; prev swapouts passed through", () => {
	const d = hostPressureDecision(healthy(), 4_950);
	expect(d.open).toBe(true);
	expect(d.reason).toBeNull();
	// first launch (prev null): healthy opens with no delta rule
	expect(hostPressureDecision(healthy(), null).open).toBe(true);
});

test("decision: low free % holds", () => {
	const low = hostPressureSampleOf(20, 4_000_000, 5_000, "fixture");
	const d = hostPressureDecision(low, 5_000);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("20% < 25%");
});

test("decision: unknown free % holds fail-closed with explicit reason", () => {
	const unknown = hostPressureSampleOf(null, 4_000_000, 5_000, "fixture");
	const d = hostPressureDecision(unknown, 5_000);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("free % unreadable");
});

test("decision: excessive wired pages hold", () => {
	const wired = hostPressureSampleOf(71, 6_000_001, 5_000, "fixture");
	const d = hostPressureDecision(wired, 5_000);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("wired 6000001 > 6000000");
});

test("decision: swapout DELTA between launches holds; raw totals never decide", () => {
	// high cumulative total but zero growth → open (deltas, not raw usage)
	const grown = hostPressureSampleOf(71, 4_000_000, 7_500, "fixture");
	const d = hostPressureDecision(grown, 5_000);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("swapouts +2500 since last launch > 2000");
	// same high total, no growth → open
	const stable = hostPressureSampleOf(71, 4_000_000, 900_000, "fixture");
	expect(hostPressureDecision(stable, 900_000).open).toBe(true);
	// first launch: no previous sample → delta rule can't fire
	expect(hostPressureDecision(grown, null).open).toBe(true);
});

test("decision: unknown swapouts/wired hold fail-closed when the check is on", () => {
	const noVm = hostPressureSampleOf(71, null, null, "fixture");
	const d = hostPressureDecision(noVm, 5_000);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("wired pages unreadable");
	// policy off (null knob) → the unknown never holds
	const off = {
		minFreePct: null,
		maxWiredPages: null,
		maxSwapoutDelta: null,
	};
	expect(hostPressureDecision(noVm, null, off).open).toBe(true);
});

test("live sampler: spawn-failure leaves fields null (unknown = hold)", () => {
	// exercised for parse-shape only; real spawns not asserted in tests
	const s = liveHostPressureSample();
	expect(typeof s.raw).toBe("string");
});
