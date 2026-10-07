// packages/blam/bench/consult/types.ts — shared types for the consult
// evaluation harness. Deterministic, LLM-optional: lanes are policy
// stand-ins, the plane is a scripted consult backend. Spec:
// bench/consult/scenario.md; metric semantics follow docs/metrics.md and
// toto-gpt.md § "How to evaluate whether it works" (W447).
import type { ConsultPlane } from "./plane.ts";

/** Matched task groups — every policy runs the same instances. */
export type TaskProfile =
	| "shared-api-uncertainty"
	| "migration-knowledge"
	| "conflicting-assumptions"
	| "no-consult-control";

export interface TaskInstance {
	id: string;
	profile: TaskProfile;
	/** code version this task executes against */
	codeVersion: string;
}

/** A verified knowledge-base row. */
export interface KbRow {
	id: string;
	/** package path the answer applies to */
	scope: string;
	/** version the answer was verified against */
	codeVersion: string;
	answer: string;
	verified: boolean;
}

export interface Expert {
	scope: string;
	live: boolean;
}

/** Injected delivery health for the consult channel. */
export type DeliveryMode = "ok" | "drop-first" | "drop-all";

export interface PlaneConfig {
	experts: Expert[];
	kb: KbRow[];
	/** the version tasks execute against (freshness reference) */
	currentVersion: string;
	delivery: DeliveryMode;
	/** minutes from question to answer delivery */
	latencyMin: number;
}

export type AskOutcome =
	| { kind: "answered"; useful: boolean }
	| { kind: "undelivered" }
	| { kind: "no-expert" };

/** One live consult round-trip through the plane. */
export interface AskRecord {
	taskId: string;
	outcome: AskOutcome;
	tokens: number;
	latencyMin: number;
}

export interface TaskPlan {
	/** investigation units run before the first consult/reuse decision */
	duplicateInvestigationUnits: number;
	/** apply from KB without a live call (fresh verified row) */
	reusedFromKb: boolean;
	/** applied KB row's version mismatches the task's code version */
	staleRowApplied: boolean;
	/** true when the profile gives the lane no trigger to consult */
	trigger: boolean;
}

/** Metric counters — the W447 metric list. Semantics: scenario.md. */
export interface ConsultMetrics {
	consultationOpportunities: number;
	attemptedCalls: number;
	deliveryFailures: number;
	usefulAnswers: number;
	appliedVerified: number;
	staleAnswers: number;
	unhelpfulAnswers: number;
	blockedTimeMin: number;
	duplicateInvestigationUnits: number;
	retries: number;
	tokenCost: number;
	completionTimeMin: number;
	correctTasks: number;
	totalTasks: number;
}

/** Cost model constants (tokens/minutes per unit). Scenario-tunable. */
export const COSTS = {
	investigateTokens: 400,
	investigateMin: 5,
	consultTokens: 250,
	consultLatencyMin: 6,
	kbReadTokens: 30,
	redoTokens: 600,
	redoMin: 15,
} as const;

/** Policy name — the three arms of the W447 comparison. */
export type PolicyName =
	| "current-instructions"
	| "trigger"
	| "trigger+verified-reuse";

/** Per-arm tunables. */
export interface PolicyCosts {
	/** duplicate-investigation units before consulting (arm A) */
	dupUnitsBeforeConsult: number;
	/** live-call retry budget after an undelivered answer */
	maxAskAttempts: number;
}

export const DEFAULT_POLICY_COSTS: PolicyCosts = {
	dupUnitsBeforeConsult: 2,
	maxAskAttempts: 2,
};

/** Everything a policy sees for one task instance. */
export interface PolicyContext {
	plane: ConsultPlane;
	task: TaskInstance;
	costs: PolicyCosts;
}

/**
 * Policy descriptor — the arm differences live in this DATA, not in
 * hand-written control flow: when the consult trigger fires, whether KB
 * retrieval runs first, and whether a hit is version-checked.
 */
export interface PolicySpec {
	name: PolicyName;
	/** consult only on consult-worthy profiles (never the control group) */
	skipControlGroup: boolean;
	/** duplicate-investigation units burned before the first ask (arm A) */
	dupUnitsBeforeConsult: number;
	/** retrieve verified knowledge before any live call (arms B/C) */
	kbFirst: boolean;
	/** apply a KB hit only when its version matches (arm C) */
	verifyVersion: boolean;
}

/** Per-task policy outcome. */
export interface TaskOutcome {
	taskId: string;
	profile: TaskProfile;
	correct: boolean;
	staleApplied: boolean;
}

/** Result of running one policy over one task. */
export interface PolicyResult {
	metrics: ConsultMetrics;
	perTask: TaskOutcome;
}

export function emptyMetrics(): ConsultMetrics {
	return {
		consultationOpportunities: 0,
		attemptedCalls: 0,
		deliveryFailures: 0,
		usefulAnswers: 0,
		appliedVerified: 0,
		staleAnswers: 0,
		unhelpfulAnswers: 0,
		blockedTimeMin: 0,
		duplicateInvestigationUnits: 0,
		retries: 0,
		tokenCost: 0,
		completionTimeMin: 0,
		correctTasks: 0,
		totalTasks: 0,
	};
}

export function addMetrics(a: ConsultMetrics, b: ConsultMetrics): ConsultMetrics {
	const out = { ...a };
	for (const k of Object.keys(a) as Array<keyof ConsultMetrics>) {
		out[k] = a[k] + b[k];
	}
	return out;
}
