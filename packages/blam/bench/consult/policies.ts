// packages/blam/bench/consult/policies.ts — the three consult arms as
// data-driven policy specs run by one engine (runTask). Arm differences
// are DATA in POLICIES: when the consult trigger fires, whether KB
// retrieval runs first, and whether hits are version-checked.
// Spec: bench/consult/scenario.md (W447).
import type { KbHit } from "./plane.ts";
import {
	COSTS,
	emptyMetrics,
	type ConsultMetrics,
	type PolicyContext,
	type PolicyName,
	type PolicyResult,
	type PolicySpec,
} from "./types.ts";

/** Metrics helper: one ask() with retry accounting. */
function runAsk(
	ctx: PolicyContext,
	m: ConsultMetrics,
): { answered: boolean; useful: boolean } {
	const { plane, task, costs } = ctx;
	const scope = task.profile;
	let answered = false;
	let useful = false;
	for (let attempt = 1; attempt <= costs.maxAskAttempts; attempt++) {
		m.attemptedCalls++;
		const outcome = plane.ask(task.id, scope);
		if (outcome.kind === "undelivered") {
			m.deliveryFailures++;
			m.blockedTimeMin += COSTS.consultLatencyMin;
			if (attempt < costs.maxAskAttempts) m.retries++;
		} else if (outcome.kind === "no-expert") {
			break;
		} else {
			answered = true;
			useful = outcome.useful;
			if (useful) m.usefulAnswers++;
			else m.unhelpfulAnswers++;
			break;
		}
	}
	return { answered, useful };
}

/** KB path: apply a hit, charging kb-read + redo costs. Returns whether
 * the hit handled the task (and whether the task stayed correct). */
function applyKbHit(
	hit: KbHit,
	m: ConsultMetrics,
	verifyVersion: boolean,
): { handled: boolean; correct: boolean } {
	if (hit.stale && verifyVersion) return { handled: false, correct: false };
	if (hit.stale) {
		m.staleAnswers++;
		m.tokenCost += COSTS.redoTokens;
		m.completionTimeMin += COSTS.redoMin;
	}
	m.tokenCost += COSTS.kbReadTokens;
	m.appliedVerified++;
	return { handled: true, correct: !hit.stale };
}

/** kbFirst path: retrieve, apply-if-usable, else live ask. */
function runTaskKb(
	ctx: PolicyContext,
	spec: PolicySpec,
	m: ConsultMetrics,
): { correct: boolean; staleApplied: boolean } {
	const { plane, task } = ctx;
	const hit = plane.kbLookup(task.profile);
	if (hit) {
		const r = applyKbHit(hit, m, spec.verifyVersion);
		if (r.handled) return { correct: r.correct, staleApplied: hit.stale };
	}
	const { useful } = runAsk(ctx, m);
	return { correct: useful, staleApplied: false };
}

/** Dup path (arm A): burn duplicate-investigation units, then ask. On
 * conflicting-assumptions the wrong assumption ships before the answer
 * lands, so the late consult documents the miss instead of preventing it. */
function runTaskDup(
	ctx: PolicyContext,
	spec: PolicySpec,
	m: ConsultMetrics,
): { correct: boolean; staleApplied: boolean } {
	const { task } = ctx;
	const dup = spec.dupUnitsBeforeConsult;
	m.duplicateInvestigationUnits += dup;
	m.tokenCost += dup * COSTS.investigateTokens;
	m.completionTimeMin += dup * COSTS.investigateMin;
	m.blockedTimeMin += dup * COSTS.investigateMin;
	const { useful } = runAsk(ctx, m);
	const tooLate = task.profile === "conflicting-assumptions";
	return { correct: useful && !tooLate, staleApplied: false };
}

/** The engine: run one task under a policy spec. */
export function runTask(ctx: PolicyContext, spec: PolicySpec): PolicyResult {
	const m = emptyMetrics();
	const { task } = ctx;
	const consultWorthy = task.profile !== "no-consult-control";
	if (consultWorthy) m.consultationOpportunities = 1;
	let correct = true;
	let staleApplied = false;
	if (consultWorthy) {
		const r = spec.kbFirst ? runTaskKb(ctx, spec, m) : runTaskDup(ctx, spec, m);
		correct = r.correct;
		staleApplied = r.staleApplied;
	}
	m.correctTasks = correct ? 1 : 0;
	m.totalTasks = 1;
	return {
		metrics: m,
		perTask: { taskId: task.id, profile: task.profile, correct, staleApplied },
	};
}

export const POLICIES: Record<PolicyName, PolicySpec> = {
	"current-instructions": {
		name: "current-instructions",
		skipControlGroup: true,
		dupUnitsBeforeConsult: 2,
		kbFirst: false,
		verifyVersion: false,
	},
	trigger: {
		name: "trigger",
		skipControlGroup: true,
		dupUnitsBeforeConsult: 0,
		kbFirst: true,
		verifyVersion: false,
	},
	"trigger+verified-reuse": {
		name: "trigger+verified-reuse",
		skipControlGroup: true,
		dupUnitsBeforeConsult: 0,
		kbFirst: true,
		verifyVersion: true,
	},
};

// The cost model is part of the policy surface.
export { COSTS, DEFAULT_POLICY_COSTS } from "./types.ts";
