// packages/blam/bench/supervise/types.ts — shared types for the supervisor
// coordination benchmark. Deterministic, LLM-optional: supervisors are
// regime stand-ins, the plane is a scripted claims/capacity ledger.
// Spec: bench/supervise/scenario.md; metric semantics follow
// docs/metrics.md. Parent mission: W977 (matched BLAM evaluation of
// bounded supervisor consultation against independent supervisors).
import type { CoordPlane } from "./plane.ts";

/** A supervisor in the scenario fleet. */
export type SupervisorId = "s1" | "s2" | "s3";

export const SUPERVISORS: SupervisorId[] = ["s1", "s2", "s3"];

/** One work item on a supervisor's queue. `scope` is the shared resource:
 * the same scope on two queues is the double-writer risk (C4). */
export interface WorkItem {
	id: string;
	scope: string;
	durationMin: number;
	/** lanes held for the item's execution */
	lanes: number;
}

/** Per-supervisor queue plus the local budget an independent regime
 * trusts instead of the shared view. */
export interface SupervisorQueue {
	sid: SupervisorId;
	items: WorkItem[];
	localBudget: number;
}

/** What one consult ask returns when delivered: the ledger truth. */
export interface LedgerView {
	/** foreign claim or completion on the scope, if any */
	foreign: { scope: string; holder: SupervisorId } | null;
	/** lanes held at the asking supervisor's clock */
	inUse: number;
	/** shared lane budget */
	budget: number;
	/** earliest release of currently held lanes (0 when none held) */
	nextFreeMin: number;
}

export type ConsultOutcome =
	| { kind: "view"; view: LedgerView }
	| { kind: "undelivered" };

export type DeliveryMode = "ok" | "drop-first" | "drop-all";

export interface PlaneConfig {
	/** shared machine lane budget (the capacity all supervisors share) */
	budget: number;
	delivery: DeliveryMode;
	/** minutes from ask to answer delivery */
	latencyMin: number;
}

export type ClaimOutcome =
	| { kind: "claimed" }
	| { kind: "refused"; holder: SupervisorId };

/** The ledger topic an ask names. The claims topic returns the combined
 * view (claims + capacity) in one answer — the boundedness design: one
 * ask covers the whole decision. Capacity re-asks model the unbounded
 * regime re-verifying unchanged state. */
export type ConsultTopic =
	| { kind: "claims"; scope: string }
	| { kind: "capacity" };

/** Result of one consult attempt. */
export interface ConsultRecord {
	delivered: boolean;
	/** minutes blocked for this ask (answer wait, or lost-answer wait) */
	latencyMin: number;
}

/** Metric counters — the supervision analogue of the W447 list.
 * Semantics: scenario.md § metrics. */
export interface CoordMetrics {
	consultCalls: number;
	consultTokens: number;
	consultFailures: number;
	consultRetries: number;
	claimAttempts: number;
	claimConflicts: number;
	/** clean yields on consult truth (foreign claim/completion seen) */
	yieldedItems: number;
	/** items refused by the ledger on a blind claim (probe cost paid) */
	refusedItems: number;
	/** items re-run on a scope another supervisor already completed */
	duplicateUnits: number;
	/** spawns executed while held lanes exceeded the shared budget */
	oversubEvents: number;
	/** lane-minutes executed above the shared budget */
	oversubscribedLaneMin: number;
	/** consult latency + capacity waits + lost-answer waits */
	blockedTimeMin: number;
	/** extra execution minutes charged by capacity contention (thrash) */
	thrashMin: number;
	completedItems: number;
	totalItems: number;
	/** simulation wall time: max supervisor clock at the end */
	makespanMin: number;
}

/** Cost model constants (tokens/minutes per unit). Scenario-tunable. */
export const COSTS = {
	consultTokens: 120,
	consultLatencyMin: 4,
	/** wasted work charged when a blind claim hits a foreign claim */
	probeTokens: 80,
	probeMin: 5,
	/** redo cost per duplicate unit (re-run of a completed scope) */
	redoTokens: 700,
	/** duration multiplier while held lanes exceed the shared budget */
	thrashFactor: 2,
} as const;

/** The three regimes of the comparison. */
export type RegimeName =
	| "independent"
	| "coordinated-bounded"
	| "coordinated-unbounded";

/**
 * Regime descriptor — the arm differences live in this DATA, not in
 * hand-written control flow: whether the ledger is consulted before
 * claiming, the bounded ask budget, redundant re-asks per item, whether
 * the regime claims through the transactional ledger, and whether the
 * capacity view gates spawns (wait instead of oversubscribe).
 */
export interface RegimeSpec {
	name: RegimeName;
	/** ask the ledger before claiming/running (the coordination act) */
	consultBeforeClaim: boolean;
	/** ask budget per item decision (boundedness) */
	maxConsultAttempts: number;
	/** redundant capacity re-asks per item (re-verifying unchanged state) */
	extraCapacityAsks: number;
	/** claim through the transactional ledger */
	usesLedger: boolean;
	/** wait for capacity instead of oversubscribing, per the view */
	respectCapacityView: boolean;
}

export const REGIMES: Record<RegimeName, RegimeSpec> = {
	independent: {
		name: "independent",
		consultBeforeClaim: false,
		maxConsultAttempts: 0,
		extraCapacityAsks: 0,
		usesLedger: false,
		respectCapacityView: false,
	},
	"coordinated-bounded": {
		name: "coordinated-bounded",
		consultBeforeClaim: true,
		maxConsultAttempts: 2,
		extraCapacityAsks: 0,
		usesLedger: true,
		respectCapacityView: true,
	},
	"coordinated-unbounded": {
		name: "coordinated-unbounded",
		consultBeforeClaim: true,
		maxConsultAttempts: 4,
		extraCapacityAsks: 2,
		usesLedger: true,
		respectCapacityView: true,
	},
};

/** Everything one regime run sees. */
export interface RunContext {
	plane: CoordPlane;
	queues: SupervisorQueue[];
	spec: RegimeSpec;
}

/** Per-item outcome kind. */
export type ItemResult = "completed" | "yielded" | "refused" | "duplicate";

/** Per-item outcome. */
export interface ItemOutcome {
	item: WorkItem;
	result: ItemResult;
}

/** Result of running one regime over one scenario. */
export interface RunResult {
	metrics: CoordMetrics;
	outcomes: ItemOutcome[];
}

export function emptyMetrics(): CoordMetrics {
	return {
		consultCalls: 0,
		consultTokens: 0,
		consultFailures: 0,
		consultRetries: 0,
		claimAttempts: 0,
		claimConflicts: 0,
		yieldedItems: 0,
		refusedItems: 0,
		duplicateUnits: 0,
		oversubEvents: 0,
		oversubscribedLaneMin: 0,
		blockedTimeMin: 0,
		thrashMin: 0,
		completedItems: 0,
		totalItems: 0,
		makespanMin: 0,
	};
}

export function addMetrics(a: CoordMetrics, b: CoordMetrics): CoordMetrics {
	const out = { ...a };
	for (const k of Object.keys(a) as Array<keyof CoordMetrics>) {
		out[k] = a[k] + b[k];
	}
	return out;
}
