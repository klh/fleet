// packages/blam/bench/supervise/supervisors.ts — the regime engine:
// one deterministic decision procedure, three data-driven arms. Arms
// differ only in RegimeSpec data (types.ts REGIMES). No model calls.
// Spec: bench/supervise/scenario.md (W977.2).
import type { CoordPlane } from "./plane.ts";
import {
	COSTS,
	SUPERVISORS,
	emptyMetrics,
	type ClaimOutcome,
	type CoordMetrics,
	type ItemResult,
	type LedgerView,
	type RegimeSpec,
	type RunContext,
	type RunResult,
	type SupervisorId,
	type WorkItem,
} from "./types.ts";

/**
 * The per-item decision procedure: consult → yield/claim → capacity
 * gate → acquire → execute → complete. Returns the supervisor's new
 * clock. `m` accumulates the run's metrics.
 */
export function runItem(
	plane: CoordPlane,
	spec: RegimeSpec,
	sid: SupervisorId,
	item: WorkItem,
	clockIn: number,
	m: CoordMetrics,
): { clock: number; outcome: ItemResult } {
	let clock = clockIn;
	let view: LedgerView | null = null;
	if (spec.consultBeforeClaim) {
		const phase = consultPhase(plane, spec, sid, item, clock, m);
		view = phase.view;
		clock += phase.clock;
	}
	if (view?.foreign) {
		m.yieldedItems++;
		return { clock, outcome: "yielded" };
	}
	if (spec.usesLedger) {
		m.claimAttempts++;
		const r: ClaimOutcome = plane.claim(sid, item.scope);
		if (r.kind === "refused") {
			m.claimConflicts++;
			m.refusedItems++;
			m.consultTokens += COSTS.probeTokens;
			m.blockedTimeMin += COSTS.probeMin;
			clock += COSTS.probeMin;
			return { clock, outcome: "refused" };
		}
	}
	// 4. Redundant capacity re-asks (the unbounded arm's re-verification).
	for (let i = 0; i < spec.extraCapacityAsks; i++) {
		m.consultCalls++;
		m.consultTokens += COSTS.consultTokens;
		const { record, outcome } = plane.consult(sid, { kind: "capacity" }, clock);
		if (outcome.kind === "undelivered") {
			m.consultFailures++;
			m.blockedTimeMin += record.latencyMin;
		} else {
			clock += record.latencyMin;
			m.blockedTimeMin += record.latencyMin;
		}
	}
	// 5. Capacity gate: wait for a release instead of oversubscribing.
	// Gating requires a delivered view — with consults down (drop-all)
	// even coordinated regimes degrade to unverified spawns, which is
	// exactly the measured degradation. Independent regimes skip this
	// entirely — their spawns always land.
	if (spec.respectCapacityView && view) {
		while (plane.heldAt(clock) + item.lanes > plane.budget) {
			const next = plane.nextFreeAt(clock);
			if (next === 0) break;
			m.blockedTimeMin += next - clock;
			clock = next;
		}
	}
	// 6. Acquire; thrash multiplies the duration when held lanes exceed
	// the shared budget (contended execution slows everyone).
	const acq = plane.acquire(sid, item.lanes, clock, item.durationMin);
	if (acq.thrashed) {
		m.oversubEvents++;
		m.oversubscribedLaneMin += acq.overBy * item.durationMin;
		m.thrashMin += acq.overBy * item.durationMin * (COSTS.thrashFactor - 1);
	}
	const duration = acq.thrashed
		? item.durationMin * COSTS.thrashFactor
		: item.durationMin;
	// 7. Execute + complete. Second finisher of a scope = duplicate work.
	clock += duration;
	const first = plane.complete(sid, item.scope);
	if (!first) {
	 m.duplicateUnits++;
		m.consultTokens += COSTS.redoTokens;
	}
	m.completedItems++;
	return { clock, outcome: first ? "completed" : "duplicate" };
}

/**
 * The bounded consult phase: up to maxConsultAttempts asks for the
 * combined claims+capacity view. Delivered answers charge latency;
 * undelivered ones charge the lost-answer wait. Returns the view
 * (null when never delivered) and the minutes burned.
 */
function consultPhase(
	plane: CoordPlane,
	spec: RegimeSpec,
	sid: SupervisorId,
	item: WorkItem,
	clockIn: number,
	m: CoordMetrics,
): { view: LedgerView | null; clock: number } {
	let clock = clockIn;
	let view: LedgerView | null = null;
	for (let attempt = 1; attempt <= spec.maxConsultAttempts; attempt++) {
		m.consultCalls++;
		m.consultTokens += COSTS.consultTokens;
		const { record, outcome } = plane.consult(
			sid,
			{ kind: "claims", scope: item.scope },
			clock,
		);
		if (outcome.kind === "undelivered") {
			m.consultFailures++;
			m.blockedTimeMin += record.latencyMin;
			if (attempt < spec.maxConsultAttempts) m.consultRetries++;
			continue;
		}
		view = outcome.view;
		clock += record.latencyMin;
		m.blockedTimeMin += record.latencyMin;
		break;
	}
	return { view, clock };
}

/**
 * Run one regime over a scenario: process all queued items in clock
 * order (ties by sid), one atomic step per item. Returns metrics and
 * per-item outcomes; makespan = the max supervisor clock at the end.
 */
export function runRegime(ctx: RunContext): RunResult {
	const { plane, queues, spec } = ctx;
	const m = emptyMetrics();
	const outcomes: ItemOutcome[] = [];
	const clocks = new Map<SupervisorId, number>(SUPERVISORS.map((s) => [s, 0]));
	const pending = new Map(queues.map((q) => [q.sid, [...q.items]]));
	for (;;) {
		let pick: SupervisorId | null = null;
		let pickClock = Number.POSITIVE_INFINITY;
		for (const sid of SUPERVISORS) {
			const q = pending.get(sid);
			if (q === undefined || q.length === 0) continue;
			const c = clocks.get(sid) ?? 0;
			if (pick === null || c < pickClock) {
				pick = sid;
				pickClock = c;
			}
		}
		if (pick === null) break;
		const item = pending.get(pick)?.shift();
		if (item === undefined) break;
		const r = runItem(plane, spec, pick, item, pickClock, m);
		clocks.set(pick, r.clock);
		outcomes.push({ item, result: r.outcome });
	}
	for (const c of clocks.values()) {
		if (c > m.makespanMin) m.makespanMin = c;
	}
	m.totalItems = outcomes.length;
	return { metrics: m, outcomes };
}
