// packages/blam/bench/crash/types.ts — shared types for the CRASH S1-S5
// control-plane scenarios. Deterministic, LLM-optional: lanes are table
// stand-ins, the control plane is a policy model with pre/post-fix eras.
// Spec: bench/crash/scenario.md; metric semantics follow docs/metrics.md.
import type { ScriptedControlPlane } from "./plane.ts";

/** The five scenarios the bench README specifies. */
export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5";

export const SCENARIO_IDS: ScenarioId[] = ["S1", "S2", "S3", "S4", "S5"];

/** Control-plane era under test: pre = 2026-09-28 incident behavior,
 * post = the current guard set (scenario.md § eras). */
export type Era = "pre" | "post";

/** The control-plane adapter contract (bench README). A control plane
 * under test implements these four; ScriptedControlPlane is the v0
 * reference (policy model, two eras). */
export interface ControlPlane {
	readonly era: Era;
	init(fixtureRepo: string): void;
	/** or a scripted stand-in — the v0 plane returns table stand-ins */
	dispatchLane(item: { branch: string; sid: string }): Standin;
	sweepCycle(): void;
	onScenarioEnd(): PlaneReport;
}

/** A scripted lane stand-in: a table row, not an OS process — kill()
 * flips the row, so liveness is fully deterministic. */
export interface Standin {
	pid: number;
	cmd: string;
	kill(): void;
}

/** One plane event, tick-stamped. Drivers measure from these. */
export interface PlaneEvent {
	tick: number;
	kind: PlaneEventKind;
	/** branch / sid / pid the event is about */
	subject: string;
}

export type PlaneEventKind =
	| "retire"
	| "retire-vanished"
	| "skip-alive"
	| "skip-vanished"
	| "heal"
	| "heal-deferred"
	| "recovery-failed"
	| "force-prune"
	| "merge-ok"
	| "branch-failed"
	| "commit-landed"
	| "commit-refused"
	| "commit-foreign";

/** End-of-scenario plane report (the README onScenarioEnd contract). */
export interface PlaneReport {
	era: Era;
	events: PlaneEvent[];
}

/** One deterministic run of one scenario on one plane. */
export interface RunOutcome {
	scenario: ScenarioId;
	era: Era;
	run: number;
	/** property name → held (scenario.md § properties) */
	properties: Record<string, boolean>;
	/** ticks from injection-complete to first correct signal; null =
	 * never detected inside the window */
	ttdTicks: number | null;
	/** ticks to restored correct state; null = not restored in window */
	ttrTicks: number | null;
	/** legitimate actions denied during the window */
	falseBlocks: number;
	/** commits that existed and became unrecoverable (docs/metrics.md) */
	dataLoss: number;
}

/** Logical clock: sweep cycles are ticks; no wall clock, no RNG. */
export const WINDOW_TICKS = 3;

/** Registry-lag window (ticks) — environmental in BOTH eras; the eras
 * differ in how the sweep treats a branch-without-entry, not in the lag. */
export const REGISTRY_LAG_TICKS = 2;
