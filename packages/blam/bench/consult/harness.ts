// packages/blam/bench/consult/harness.ts — deterministic consult-policy
// comparison: three arms × matched task sets under two KB-freshness
// planes and injected delivery failures. Spec: scenario.md (W447).
// Run: bun packages/blam/bench/consult/harness.ts
import {
	COSTS,
	DEFAULT_POLICY_COSTS,
	POLICIES,
	runTask,
} from "./policies.ts";
import { ConsultPlane } from "./plane.ts";
import {
	addMetrics,
	emptyMetrics,
	type ConsultMetrics,
	type DeliveryMode,
	type KbRow,
	type PolicyName,
	type TaskInstance,
	type TaskOutcome,
} from "./types.ts";


/** The matched task set every arm runs on every plane. */
export function matchedSet(codeVersion: string): TaskInstance[] {
	return [
		{ id: "t1", profile: "shared-api-uncertainty", codeVersion },
		{ id: "t2", profile: "migration-knowledge", codeVersion },
		{ id: "t3", profile: "conflicting-assumptions", codeVersion },
		{ id: "t4", profile: "no-consult-control", codeVersion },
	];
}


/** Scenario config + builders. kbVersion: the KB row's version (empty
 * string = no row). delivery: injected consult-channel health. */
export interface ScenarioConfig {
	codeVersion: string;
	kbVersion: string;
	delivery: DeliveryMode;
}

/** The KB the plane holds: one verified migration row, possibly stale. */
export function kbFor(cfg: ScenarioConfig): KbRow[] {
	if (cfg.kbVersion === "") return [];
	return [
		{
			id: "kb-migration-1",
			scope: "migration-knowledge",
			codeVersion: cfg.kbVersion,
			answer: "migrate via the two-phase registry rekey",
			verified: true,
		},
	];
}


/** Expert roster: one live expert per consult-worthy scope; the control
 * scope has none. */
export function expertsFor(): Array<{ scope: string; live: boolean }> {
	return [
		{ scope: "shared-api-uncertainty", live: true },
		{ scope: "migration-knowledge", live: true },
		{ scope: "conflicting-assumptions", live: true },
	];
}

export function planeFor(cfg: ScenarioConfig): ConsultPlane {
	return new ConsultPlane({
		experts: expertsFor(),
		kb: kbFor(cfg),
		currentVersion: cfg.codeVersion,
		delivery: cfg.delivery,
		latencyMin: COSTS.consultLatencyMin,
	});
}


/** Run one arm over the matched set under one scenario config. */
export function runPolicy(
	name: PolicyName,
	cfg: ScenarioConfig,
): { total: ConsultMetrics; perTask: TaskOutcome[] } {
	const plane = planeFor(cfg);
	const spec = POLICIES[name];
	let total = emptyMetrics();
	const perTask: TaskOutcome[] = [];
	for (const task of matchedSet(cfg.codeVersion)) {
		const r = runTask({ plane, task, costs: DEFAULT_POLICY_COSTS }, spec);
		total = addMetrics(total, r.metrics);
		perTask.push(r.perTask);
	}
	return { total, perTask: perTask };
}


/** The scenario matrix the harness scores. */
export const SCENARIOS: ScenarioConfig[] = [
	{ codeVersion: "v2", kbVersion: "v2", delivery: "ok" },
	{ codeVersion: "v2", kbVersion: "v1", delivery: "ok" },
	{ codeVersion: "v2", kbVersion: "v2", delivery: "drop-first" },
	{ codeVersion: "v2", kbVersion: "v1", delivery: "drop-all" },
];


export const FRESH: ScenarioConfig = SCENARIOS[0];
export const STALE: ScenarioConfig = SCENARIOS[1];
export const DROP_FIRST: ScenarioConfig = SCENARIOS[2];
export const DROP_ALL: ScenarioConfig = SCENARIOS[3];

/** Run one arm over the full matrix. */
export function runArm(name: PolicyName): Array<{ cfg: ScenarioConfig; total: ConsultMetrics }> {
	return SCENARIOS.map((cfg) => ({ cfg, total: runPolicy(name, cfg).total }));
}


/** Bench properties — violations empty means the deterministic contract
 * holds (≥9/10 runs ≡ 100%: no RNG anywhere in the harness). */
export function checkProperties(): string[] {
	const v: string[] = [];
	const a = runPolicy("current-instructions", FRESH).total;
	const b = runPolicy("trigger", FRESH).total;
	const c = runPolicy("trigger+verified-reuse", FRESH).total;
	if (!(a.duplicateInvestigationUnits > 0 && b.duplicateInvestigationUnits === 0 && c.duplicateInvestigationUnits === 0))
		v.push("P1 dup-investigation");
	const s = runPolicy("trigger", STALE).total;
	const cS = runPolicy("trigger+verified-reuse", STALE).total;
	if (!(s.staleAnswers >= 1 && cS.staleAnswers === 0)) v.push("P2 stale");
	const nc = matchedSet("v2").find((t) => t.profile === "no-consult-control");
	if (nc === undefined) return ["P3 control: task missing"];
	for (const arm of ["current-instructions", "trigger", "trigger+verified-reuse"] as const) {
		const r = runTask({ plane: planeFor(FRESH), task: nc, costs: DEFAULT_POLICY_COSTS }, POLICIES[arm]);
		if (r.metrics.attemptedCalls !== 0) v.push(`P3 control: ${arm} consulted`);
	}
	const cAll = runPolicy("trigger+verified-reuse", FRESH).total;
	const cStale = runPolicy("trigger+verified-reuse", STALE).total;
	if (!(cAll.correctTasks === 4 && cStale.correctTasks === 4)) v.push("P4 arm C correctness");
	const df = runPolicy("trigger+verified-reuse", DROP_FIRST).total;
	if (df.deliveryFailures < 1) v.push("P5 delivery accounting");
	const again = runPolicy("trigger", FRESH).total;
	if (JSON.stringify(again) !== JSON.stringify(runPolicy("trigger", FRESH).total)) v.push("P6 determinism");
	return v;
}


function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Comparison table over the scenario matrix. */
export function formatComparison(): string {
	const arms: PolicyName[] = ["current-instructions", "trigger", "trigger+verified-reuse"];
	const rows: string[] = [];
	for (const arm of arms) {
		for (const { cfg, total } of runArm(arm)) {
			rows.push(
				pad(arm, 24) +
					pad(`${cfg.kbVersion === cfg.codeVersion ? "fresh" : "stale"}-kb`, 9) +
					pad(cfg.delivery, 12) +
					`ok=${total.correctTasks}/${total.totalTasks} calls=${total.attemptedCalls} ` +
					`dfail=${total.deliveryFailures} useful=${total.usefulAnswers} ` +
					`stale=${total.staleAnswers} dup=${total.duplicateInvestigationUnits} ` +
					`blocked=${total.blockedTimeMin}m tok=${total.tokenCost}`,
			);
		}
	}
	return rows.join("\n");
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
