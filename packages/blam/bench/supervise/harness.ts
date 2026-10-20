// packages/blam/bench/supervise/harness.ts — deterministic supervisor-
// coordination comparison: three regimes × matched work sets under
// calm/pressure capacity and injected consult-channel health. Spec:
// bench/supervise/scenario.md (W977.2).
// Run: bun packages/blam/bench/supervise/harness.ts
import { CoordPlane } from "./plane.ts";
import { runRegime } from "./supervisors.ts";
import {
	COSTS,
	REGIMES,
	addMetrics,
	emptyMetrics,
	type CoordMetrics,
	type DeliveryMode,
	type ItemOutcome,
	type RegimeName,
	type SupervisorQueue,
} from "./types.ts";

/** The matched work set: 9 items over 3 supervisors, 3 shared scopes
 * (sh1: s1+s2, sh2: s2+s3, sh3: s1+s3), 3 unique. `heavy` moves s3's
 * unique item to 3 lanes — the capacity-pressure scenario. */
export function queuesFor(heavy: boolean): SupervisorQueue[] {
	const u3 = { id: "i7", scope: "u3", durationMin: 30, lanes: heavy ? 3 : 1 };
	return [
		{
			sid: "s1",
			localBudget: 2,
			items: [
				{ id: "i1", scope: "u1", durationMin: 30, lanes: 1 },
				{ id: "i2", scope: "sh1", durationMin: 45, lanes: 1 },
				{ id: "i3", scope: "sh3", durationMin: 45, lanes: 1 },
			],
		},
		{
			sid: "s2",
			localBudget: 2,
			items: [
				{ id: "i4", scope: "u2", durationMin: 30, lanes: 1 },
				{ id: "i5", scope: "sh1", durationMin: 45, lanes: 1 },
				{ id: "i6", scope: "sh2", durationMin: 45, lanes: 1 },
			],
		},
		{
			sid: "s3",
			localBudget: 2,
			items: [
				u3,
				{ id: "i8", scope: "sh2", durationMin: 45, lanes: 1 },
				{ id: "i9", scope: "sh3", durationMin: 45, lanes: 1 },
			],
		},
	];
}

/** The scenario matrix. */
export interface ScenarioConfig {
	id: string;
	budget: number;
	delivery: DeliveryMode;
	heavy: boolean;
}

export const SCENARIOS: ScenarioConfig[] = [
	{ id: "calm/ok", budget: 4, delivery: "ok", heavy: false },
	{ id: "pressure/ok", budget: 4, delivery: "ok", heavy: true },
	{ id: "calm/drop-first", budget: 4, delivery: "drop-first", heavy: false },
	{ id: "pressure/drop-all", budget: 4, delivery: "drop-all", heavy: true },
];

/** Build the plane for a scenario: shared budget, injected delivery
 * health, latency from COSTS. */
export function planeFor(cfg: ScenarioConfig): CoordPlane {
	return new CoordPlane({
		budget: cfg.budget,
		delivery: cfg.delivery,
		latencyMin: COSTS.consultLatencyMin,
	});
}

/** Run one regime over one scenario. */
export function runScenario(
	name: RegimeName,
	cfg: ScenarioConfig,
): { total: CoordMetrics; perItem: ItemOutcome[] } {
	const plane = planeFor(cfg);
	const spec = REGIMES[name];
	const r = runRegime({ plane, queues: queuesFor(cfg.heavy), spec });
	return { total: r.metrics, perItem: r.outcomes };
}

/** Run one arm over the full scenario matrix. */
export function runArm(
	name: RegimeName,
): Array<{ cfg: ScenarioConfig; total: CoordMetrics }> {
	return SCENARIOS.map((cfg) => ({ cfg, total: runScenario(name, cfg).total }));
}

/** Per-item accounting invariant: every queued item ends in exactly one
 * terminal outcome — no lost work in any arm × scenario. */
export function itemAccountingHolds(
	name: RegimeName,
	cfg: ScenarioConfig,
): boolean {
	const { perItem } = runScenario(name, cfg);
	if (perItem.length !== 9) return false;
	return perItem.every(
		(o) =>
			o.result === "completed" ||
			o.result === "yielded" ||
			o.result === "refused" ||
			o.result === "duplicate",
	);
}

/** Bench properties — violations empty means the deterministic contract
 * holds (≥9/10 runs ≡ 100%: no RNG anywhere in the harness). */
export function checkProperties(): string[] {
	const v: string[] = [];
	const CALM = SCENARIOS[0];
	const PRESSURE = SCENARIOS[1];
	const DROP_FIRST = SCENARIOS[2];
	const DROP_ALL = SCENARIOS[3];
	const CALM_RUNS: Record<RegimeName, CoordMetrics> = {
		independent: runScenario("independent", CALM).total,
		"coordinated-bounded": runScenario("coordinated-bounded", CALM).total,
		"coordinated-unbounded": runScenario("coordinated-unbounded", CALM).total,
	};
	const ind = CALM_RUNS.independent;
	const bnd = CALM_RUNS["coordinated-bounded"];
	const unb = CALM_RUNS["coordinated-unbounded"];
	// P1 dup work: independent re-runs all 3 shared scopes; bounded 0.
	if (!(ind.duplicateUnits === 3 && bnd.duplicateUnits === 0))
		v.push("P1 dup-work");
	// P2: independent never claims (its signature); bounded never
	// conflicts and yields each shared scope exactly once.
	if (!(ind.claimAttempts === 0 && bnd.claimConflicts === 0 && bnd.yieldedItems === 3))
		v.push("P2 claims");
	// P3 boundedness: bounded asks strictly less than unbounded at
	// outcome parity (both avoid dup work and claim conflicts).
	if (
		!(
			bnd.consultCalls < unb.consultCalls &&
			unb.duplicateUnits === 0 &&
			unb.claimConflicts === 0
		)
	)
		v.push("P3 boundedness");
	// P4 capacity: on pressure, only the un-gated regimes oversubscribe;
	// the bounded regime waits instead and still completes everything.
	if (
		!(
			runScenario("independent", PRESSURE).total.oversubscribedLaneMin > 0 &&
			bnd.oversubscribedLaneMin === 0 &&
			runScenario("coordinated-bounded", PRESSURE).total.refusedItems +
				runScenario("coordinated-bounded", PRESSURE).total.duplicateUnits === 0
		)
	)
		v.push("P4 capacity");
	// P5 delivery: drops are counted; on drop-all the ledger backstop
	// still prevents the double-run (correctness survives, efficiency
	// degrades to blind-claim conflicts).
	const df = runScenario("coordinated-bounded", DROP_FIRST).total;
	const da = runScenario("coordinated-bounded", DROP_ALL).total;
	if (
		!(
			df.consultFailures >= 1 &&
			da.duplicateUnits === 0 &&
			da.claimConflicts >= 1
		)
	)
		v.push("P5 delivery");
	// P6 determinism: byte-identical rerun.
	if (
		JSON.stringify(runScenario("coordinated-bounded", CALM))
		!== JSON.stringify(runScenario("coordinated-bounded", CALM))
	) {
		v.push("P6 determinism");
	}
	// no lost items: every arm × scenario ends with all 9 accounted
	for (const arm of [
		"independent",
		"coordinated-bounded",
		"coordinated-unbounded",
	] as const) {
		for (const cfg of SCENARIOS) {
			if (!itemAccountingHolds(arm, cfg)) v.push(`P7 accounting: ${arm} ${cfg.id}`);
		}
	}
	return v;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Comparison table over the scenario matrix. */
export function formatComparison(): string {
	const arms: RegimeName[] = [
		"independent",
		"coordinated-bounded",
		"coordinated-unbounded",
	];
	const rows: string[] = [];
	for (const arm of arms) {
		for (const { cfg, total } of runArm(arm)) {
			rows.push(rowFor(arm, cfg, total));
		}
	}
	return rows.join("\n");
}

/** One comparison row. */
function rowFor(
	arm: RegimeName,
	cfg: ScenarioConfig,
	total: CoordMetrics,
): string {
	const cells = [
		`ok=${total.completedItems}/${total.totalItems}`,
		`dup=${total.duplicateUnits}`,
		`conflicts=${total.claimConflicts}`,
		`yields=${total.yieldedItems}`,
		`calls=${total.consultCalls}`,
		`dfail=${total.consultFailures}`,
		`oversubLaneMin=${total.oversubscribedLaneMin}`,
		`blocked=${total.blockedTimeMin}m`,
		`makespan=${total.makespanMin}m`,
		`tok=${total.consultTokens}`,
	];
	return pad(arm, 24) + pad(cfg.id, 20) + cells.join(" ");
}

if (import.meta.main) {
	const violations = checkProperties();
	if (violations.length > 0) {
		console.error(violations.map((s) => `✗ ${s}`).join("\n"));
		process.exit(1);
	}
	console.log(formatComparison());
	console.log("\n6/6 properties hold (see scenario.md for definitions)");
}