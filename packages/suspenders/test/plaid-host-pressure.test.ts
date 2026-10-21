// test/plaid-host-pressure.test.ts — W1102.1: host-pressure gate. Fixture
// samplers only — no real memory_pressure/vm_stat spawns in tests.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HOST_PRESSURE_POLICY,
	HOST_PRESSURE_STATE_FILE,
	hostPressureDecision,
	hostPressureGate,
	hostPressureSampleOf,
	liveHostPressureSample,
	launchPressurePolicy,
	launchWiredCeilingBytes,
	parseFreePct,
	parsePageSizeBytes,
	parseSwapouts,
	parseWiredPages,
	plaidLaunchHold,
	readHostPressureState,
} from "../hooks/lib/plaid-host-pressure.ts";

const HEALTHY_MP = "System-wide memory free percentage: 71%";
const HEALTHY_VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 123456.
Pages wired down: 4000000.
Swapins: 100.
Swapouts: 5000.`;

// explicit policy in tests — never the env-derived default (ambient
// BELT_WIRED_GUARD_GB must not decide test outcomes)
const POLICY = {
	minFreePct: 25,
	maxWiredBytes: 96 * 1024 ** 3,
	maxSwapoutDelta: 2_000,
};

const healthy = () =>
	hostPressureSampleOf(
		parseFreePct(HEALTHY_MP),
		parseWiredPages(HEALTHY_VM),
		parseSwapouts(HEALTHY_VM),
		"fixture",
		parsePageSizeBytes(HEALTHY_VM),
	);

test("parsers: free %, wired pages, page size, cumulative swapouts; junk → null", () => {
	expect(parseFreePct("System-wide memory free percentage: 71%")).toBe(71);
	expect(parseFreePct("free percentage: 43.5%")).toBe(43.5);
	// malformed/out-of-range free % → unknown (hold)
	expect(parseFreePct("free percentage: 999%")).toBeNull();
	expect(parseFreePct("garbage")).toBeNull();
	expect(parseWiredPages("Pages wired down: 4000000.")).toBe(4_000_000);
	expect(parseWiredPages("no data")).toBeNull();
	expect(parsePageSizeBytes(HEALTHY_VM)).toBe(16384);
	expect(parsePageSizeBytes("(page size of 4096 bytes)")).toBe(4096);
	expect(parsePageSizeBytes("no header")).toBeNull();
	expect(parseSwapouts("Swapouts: 5000.")).toBe(5_000);
	expect(parseSwapouts("none here")).toBeNull();
});

test("decision: healthy sample opens; prev swapouts passed through", () => {
	const d = hostPressureDecision(healthy(), 4_950, POLICY);
	expect(d.open).toBe(true);
	expect(d.reason).toBeNull();
	// first launch (prev null): healthy opens with no delta rule
	expect(hostPressureDecision(healthy(), null, POLICY).open).toBe(true);
});

test("decision: low free % holds", () => {
	const low = hostPressureSampleOf(20, 4_000_000, 5_000, "fixture");
	const d = hostPressureDecision(low, 5_000, POLICY);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("20% < 25%");
});

test("decision: unknown free % holds fail-closed with explicit reason", () => {
	const unknown = hostPressureSampleOf(null, 4_000_000, 5_000, "fixture");
	const d = hostPressureDecision(unknown, 5_000, POLICY);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("free % unreadable");
});

test("decision: excessive wired BYTES hold (page-size aware)", () => {
	// 7M pages: ×4096 ≈ 28.7 GiB (open) vs ×16384 ≈ 114.9 GiB (hold) — the
	// same page count must NOT decide alone across hosts (review #1)
	const small = hostPressureSampleOf(71, 7_000_000, 5_000, "f", 4096);
	const big = hostPressureSampleOf(71, 7_000_000, 5_000, "f", 16384);
	expect(hostPressureDecision(small, 5_000, POLICY).open).toBe(true);
	const d = hostPressureDecision(big, 5_000, POLICY);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("GiB >");
	// unreadable page size → hold (page counts are page-size-relative)
	const noPs = hostPressureSampleOf(71, 7_000_000, 5_000, "f", null);
	const pd = hostPressureDecision(noPs, 5_000, POLICY);
	expect(pd.open).toBe(false);
	expect(pd.reason).toContain("page size unreadable");
});

test("decision: swapout DELTA between launches holds; raw totals never decide", () => {
	// growth over the budget between paced launches → hold
	const grown = hostPressureSampleOf(71, 4_000_000, 7_500, "fixture", 16384);
	const d = hostPressureDecision(grown, 5_000, POLICY);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("swapouts +2500 since last launch > 2000");
	// same high total, no growth → open (deltas, never raw occupancy)
	const stable = hostPressureSampleOf(71, 4_000_000, 900_000, "fixture", 16384);
	expect(hostPressureDecision(stable, 900_000, POLICY).open).toBe(true);
	// reboot/counter reset: current < previous = new baseline, opens
	const reset = hostPressureSampleOf(71, 4_000_000, 12, "fixture", 16384);
	expect(hostPressureDecision(reset, 900_000, POLICY).open).toBe(true);
	// first launch: no previous sample → delta rule can't fire
	expect(hostPressureDecision(grown, null, POLICY).open).toBe(true);
});

test("decision: unknown wired/swapouts hold fail-closed; policy off never holds", () => {
	const noVm = hostPressureSampleOf(71, null, null, "fixture");
	const d = hostPressureDecision(noVm, 5_000, POLICY);
	expect(d.open).toBe(false);
	expect(d.reason).toContain("wired pages unreadable");
	// policy off (null knobs) → the unknown never holds
	const off = {
		minFreePct: null,
		maxWiredBytes: null,
		maxSwapoutDelta: null,
	};
	expect(hostPressureDecision(noVm, null, off).open).toBe(true);
});

test("gate: baseline persists across invocations; re-anchors on outcomes", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-hp-"));
	try {
		// cycle 1: healthy → open, baseline = 5000
		const d1 = hostPressureGate(dir, healthy(), POLICY);
		expect(d1.open).toBe(true);
		expect(readHostPressureState(dir)?.swapouts).toBe(5_000);
		// cycle 2 (separate invocation): +2500 swapouts → hold, anchor moves
		const grown = hostPressureGate(
			dir,
			hostPressureSampleOf(71, 4_000_000, 7_500, "f", 16384),
			POLICY,
		);
		expect(grown.open).toBe(false);
		expect(grown.reason).toContain("+2500");
		expect(readHostPressureState(dir)?.swapouts).toBe(7_500);
		// cycle 3: clean again → reopened (deltas ride the new anchor)
		expect(
			hostPressureGate(
				dir,
				hostPressureSampleOf(71, 4_000_000, 7_600, "f", 16384),
				POLICY,
			).open,
		).toBe(true);
		// unknown sample: holds, previous anchor survives (no 0 write)
		const unknown = hostPressureGate(
			dir,
			hostPressureSampleOf(71, null, null, "f"),
			POLICY,
		);
		expect(unknown.open).toBe(false);
		expect(readHostPressureState(dir)?.swapouts).toBe(7_600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("live sampler: injectable runner; failed spawn → all-null (hold)", () => {
	const failed = liveHostPressureSample(() => null);
	expect(failed.freePct).toBeNull();
	expect(failed.wiredPages).toBeNull();
	expect(failed.swapouts).toBeNull();
	expect(failed.pageSizeBytes).toBeNull();
	const bad = liveHostPressureSample(() => ({
		exitCode: 1,
		stdout: Buffer.from("junk"),
	}));
	expect(bad.freePct).toBeNull();
	// fixture-driven success path through the injected runner
	const ok = liveHostPressureSample((cmd) => ({
		exitCode: 0,
		stdout: Buffer.from(cmd[0] === "vm_stat" ? HEALTHY_VM : HEALTHY_MP),
	}));
	expect(ok.freePct).toBe(71);
	expect(ok.wiredPages).toBe(4_000_000);
	expect(ok.swapouts).toBe(5_000);
	expect(ok.pageSizeBytes).toBe(16384);
});
