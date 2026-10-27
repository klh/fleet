// test/plaid-host-pressure.test.ts — W1102.1: host-pressure gate. Fixture
// samplers only — no real memory_pressure/vm_stat spawns in tests.
import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
} from "../hooks/lib/plaid/plaid-host-pressure.ts";

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

test("wired ceiling: valid 0600 belt.env derives guard bytes; ceiling IS the guard", () => {
	const file = guardFixture("BELT_WIRED_GUARD_GB=90\n");
	try {
		expect(launchWiredCeilingBytes(file)).toBe(90 * 1024 ** 3);
		const policy = launchPressurePolicy(file);
		expect(policy.maxWiredBytes).toBe(90 * 1024 ** 3);
		// every other knob rides the default policy
		expect(policy.minFreePct).toBe(DEFAULT_HOST_PRESSURE_POLICY.minFreePct);
		expect(policy.maxSwapoutDelta).toBe(
			DEFAULT_HOST_PRESSURE_POLICY.maxSwapoutDelta,
		);
	} finally {
		rmSync(join(file, ".."), { recursive: true, force: true });
	}
});

test("wired ceiling: missing/invalid guard → null ceiling, launch holds BEFORE baseline write", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-hold-"));
	try {
		// absent belt.env → distinct hold reason, no state file written
		const absent = join(dir, "belt.env");
		expect(launchWiredCeilingBytes(absent)).toBeNull();
		const hold = plaidLaunchHold(
			dir,
			healthy(),
			launchPressurePolicy(absent),
			absent,
		);
		expect(hold).toContain("BELT_WIRED_GUARD_GB missing/invalid");
		expect(readHostPressureState(dir)).toBeNull();
		// garbage value → same fail-closed path
		const junk = guardFixture("BELT_WIRED_GUARD_GB=garbage\n");
		expect(launchWiredCeilingBytes(junk)).toBeNull();
		rmSync(join(junk, ".."), { recursive: true, force: true });
		// a RESOLVABLE guard lets the same healthy sample through
		const good = guardFixture("BELT_WIRED_GUARD_GB=90\n");
		try {
			expect(
				plaidLaunchHold(dir, healthy(), launchPressurePolicy(good), good),
			).toBeNull();
			expect(readHostPressureState(dir)?.swapouts).toBe(5_000);
		} finally {
			rmSync(join(good, ".."), { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── W1102.1: the wired ceiling derives from the SHARED belt.env validator
// (reviews #55130/#55320/#55329) — 0600, regular file, no symlink, exactly
// one plain assignment. Tests build fixture belt.env files; the machine
// conf is never touched. ─────────────────────────────────────────────────

const guardFixture = (body: string, mode: number = 0o600): string => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-guard-"));
	const file = join(dir, "belt.env");
	writeFileSync(file, body, { mode });
	return file;
};

test("wired ceiling: wrong-mode guard rejected (not a private 0600 conf)", () => {
	const loose = guardFixture("BELT_WIRED_GUARD_GB=90\n", 0o644);
	try {
		expect(launchWiredCeilingBytes(loose)).toBeNull();
	} finally {
		rmSync(join(loose, ".."), { recursive: true, force: true });
	}
});

test("wired ceiling: symlinked guard rejected (not a regular file)", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-sym-"));
	try {
		const real = join(dir, "real.env");
		writeFileSync(real, "BELT_WIRED_GUARD_GB=90\n", { mode: 0o600 });
		const link = join(dir, "belt.env");
		symlinkSync(real, link);
		expect(launchWiredCeilingBytes(link)).toBeNull();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wired ceiling: duplicate guard assignments rejected (ambiguous conf)", () => {
	const dup = guardFixture(
		"BELT_WIRED_GUARD_GB=90\nexport BELT_WIRED_GUARD_GB=60\n",
	);
	try {
		expect(launchWiredCeilingBytes(dup)).toBeNull();
	} finally {
		rmSync(join(dup, ".."), { recursive: true, force: true });
	}
});

test("gate: stale baseline (past the paced horizon) ignored, not refreshed; malformed baselines read null", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-stale-"));
	try {
		// anchor 20 min ago — past the 15-min horizon
		writeFileSync(
			join(dir, HOST_PRESSURE_STATE_FILE),
			`${JSON.stringify({ swapouts: 5_000, ts: Date.now() - 20 * 60_000 })}\n`,
		);
		// would trip the delta vs the STALE anchor → must open (stale ignored)
		const grown = hostPressureGate(
			dir,
			hostPressureSampleOf(71, 4_000_000, 7_500, "f", 16384),
			POLICY,
		);
		expect(grown.open).toBe(true);
		const persisted = readHostPressureState(dir);
		expect(persisted?.swapouts).toBe(7_500);
		expect(persisted !== null && Date.now() - persisted.ts < 60_000).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gate: malformed baselines (null/negative/fractional/future) read as null", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-malformed-"));
	try {
		const bodies = [
			`{"swapouts":null,"ts":1}`,
			`{"swapouts":-5,"ts":${Date.now()}}`,
			`{"swapouts":5.5,"ts":${Date.now()}}`,
			`{"swapouts":5,"ts":${Date.now() + 3_600_000}}`,
		];
		for (const body of bodies) {
			writeFileSync(join(dir, HOST_PRESSURE_STATE_FILE), `${body}\n`);
			expect(readHostPressureState(dir)).toBeNull();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gate: unique tmp name — no shared-tmp interleave, no *.tmp residue", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1102-race-"));
	try {
		// 8 sequential gate writes through the unique-tmp path — every
		// persisted anchor is SOME observed sample, no residue survives
		const samples = Array.from({ length: 8 }, (_, i) => 5_000 + i * 100);
		for (const swapouts of samples) {
			const r = hostPressureGate(
				dir,
				hostPressureSampleOf(71, 4_000_000, swapouts, "f", 16384),
				POLICY,
			);
			expect(r.open).toBe(true);
		}
		const persisted = readHostPressureState(dir);
		expect(samples).toContain(persisted?.swapouts);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// W1235 bounded override (independent-review REQUEST CHANGES): env=0 removes
// ONLY the swapout-delta leg; the free% floor stays fail-closed.
test("SUSPENDERS_PLAID_PRESSURE_HOLD=0 disables ONLY the swapout delta; free% stays fail-closed", () => {
	const dir = mkdtempSync(join(tmpdir(), "w1235-hold-"));
	const good = guardFixture("BELT_WIRED_GUARD_GB=90\n");
	const prev = process.env.SUSPENDERS_PLAID_PRESSURE_HOLD;
	process.env.SUSPENDERS_PLAID_PRESSURE_HOLD = "0";
	try {
		const spiked = hostPressureSampleOf(
			parseFreePct(HEALTHY_MP),
			parseWiredPages(HEALTHY_VM),
			(parseSwapouts(HEALTHY_VM) ?? 0) + 50_000,
			"fixture",
			parsePageSizeBytes(HEALTHY_VM),
		);
		// default policy still holds on a 50k delta…
		expect(
			hostPressureDecision(spiked, parseSwapouts(HEALTHY_VM), POLICY).open,
		).toBe(false);
		// …the bounded override opens the delta leg…
		expect(
			hostPressureDecision(spiked, parseSwapouts(HEALTHY_VM), {
				...POLICY,
				maxSwapoutDelta: null,
			}).open,
		).toBe(true);
		// …but the free% floor holds even under the override (fail-closed)
		const lowFree = hostPressureSampleOf(
			10,
			parseWiredPages(HEALTHY_VM),
			(parseSwapouts(HEALTHY_VM) ?? 0) + 50_000,
			"fixture",
			parsePageSizeBytes(HEALTHY_VM),
		);
		const held = plaidLaunchHold(
			dir,
			lowFree,
			launchPressurePolicy(good),
			good,
		);
		expect(held).not.toBeNull();
	} finally {
		if (prev === undefined) delete process.env.SUSPENDERS_PLAID_PRESSURE_HOLD;
		else process.env.SUSPENDERS_PLAID_PRESSURE_HOLD = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
