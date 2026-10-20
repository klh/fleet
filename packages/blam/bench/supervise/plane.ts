// packages/blam/bench/supervise/plane.ts — the scripted coordination
// plane: a transactional claims ledger, a completions ledger, and the
// shared lane-capacity ledger, with injected delivery health on the
// consult channel. No model calls; every outcome is a function of the
// config, the attempt number, and the steps processed so far. Spec:
// bench/supervise/scenario.md (W977.2).
import type {
	ClaimOutcome,
	ConsultOutcome,
	ConsultRecord,
	ConsultTopic,
	DeliveryMode,
	LedgerView,
	PlaneConfig,
	SupervisorId,
} from "./types.ts";

/** One capacity lease: `lanes` held by `sid` until `until` (minutes). */
export interface Lease {
	sid: SupervisorId;
	lanes: number;
	until: number;
}

/** Injected consult-channel health, per (sid, topic) attempt. */
export type DeliveryFails = (key: string, attempt: number) => boolean;

/** "drop-first" fails the first ask per key, "drop-all" fails every ask. */
export function deliveryFailsFor(mode: DeliveryMode): DeliveryFails {
	if (mode === "ok") return () => false;
	if (mode === "drop-all") return () => true;
	return (_key, attempt) => attempt <= 1;
}

export class CoordPlane {
	private readonly cfg: PlaneConfig;
	private readonly claims = new Map<string, SupervisorId>();
	private readonly completions = new Map<string, SupervisorId>();
	private leases: Lease[] = [];
	private readonly attempts = new Map<string, number>();

	constructor(cfg: PlaneConfig) {
		this.cfg = cfg;
	}

	/** The shared lane budget (capacity the consult view exposes). */
	get budget(): number {
		return this.cfg.budget;
	}

	/** Lanes held at minute `t` (leases not yet expired). */
	heldAt(t: number): number {
		this.prune(t);
		return this.leases.reduce((sum, l) => sum + l.lanes, 0);
	}

	/** Earliest release of lanes still held at minute `t` (0 if none). */
	nextFreeAt(t: number): number {
		this.prune(t);
		let min = 0;
		for (const l of this.leases) {
			if (l.until > t && (min === 0 || l.until < min)) min = l.until;
		}
		return min;
	}

	/**
	 * One consult attempt. Delivery per the injected health; the answer
	 * is the ledger truth at minute `atMin`. Undelivered asks still
	 * charge latency (the lost-answer wait).
	 */
	consult(
		sid: SupervisorId,
		topic: ConsultTopic,
		atMin: number,
	): { record: ConsultRecord; outcome: ConsultOutcome } {
		const key = `${sid}\u0000${topicKey(topic)}`;
		const attempt = this.bump(key);
		const fails = deliveryFailsFor(this.cfg.delivery);
		if (fails(key, attempt)) {
			return {
				record: { delivered: false, latencyMin: this.cfg.latencyMin },
				outcome: { kind: "undelivered" },
			};
		}
		const view =
			topic.kind === "claims"
				? this.claimsView(sid, topic.scope, atMin)
				: this.capacityView(atMin);
		return {
			record: { delivered: true, latencyMin: this.cfg.latencyMin },
			outcome: { kind: "view", view },
		};
	}

	/** Transactional claim: refused when a foreign claim or completion
	 * holds the scope. Holder resolution: live claim first, then the
	 * completions ledger (a completed scope still refuses re-runs). */
	claim(sid: SupervisorId, scope: string): ClaimOutcome {
		const held = this.claims.get(scope) ?? this.completions.get(scope);
		if (held !== undefined) return { kind: "refused", holder: held };
		this.claims.set(scope, sid);
		return { kind: "claimed" };
	}

	/** Acquire capacity for one execution. Always lands — oversubscrip-
	 * tion is measured, not prevented. Thrash: held lanes above budget
	 * multiply the item's duration (contended execution). */
	acquire(
		sid: SupervisorId,
		lanes: number,
		fromMin: number,
		durationMin: number,
	): { heldBefore: number; thrashed: boolean; overBy: number } {
		const heldBefore = this.heldAt(fromMin);
		const heldAfter = heldBefore + lanes;
		this.leases.push({ sid, lanes, until: fromMin + durationMin });
		const overBy = Math.max(0, heldAfter - this.cfg.budget);
		return {
			heldBefore,
			thrashed: heldAfter > this.cfg.budget,
			overBy,
		};
	}

	/** Record completion. Returns false when the scope was already
	 * completed (the duplicate-work signal). */
	complete(sid: SupervisorId, scope: string): boolean {
		const dup = this.completions.has(scope);
		this.completions.set(scope, sid);
		this.claims.delete(scope);
		return !dup;
	}

	private claimsView(sid: SupervisorId, scope: string, atMin: number): LedgerView {
		const claimHolder = this.claims.get(scope);
		const done = this.completions.get(scope);
		const foreign =
			claimHolder !== undefined && claimHolder !== sid
				? { scope, holder: claimHolder }
				: done !== undefined && done !== sid
					? { scope, holder: done }
					: null;
		const cap = this.capacityView(atMin);
		return {
			foreign,
			inUse: cap.inUse,
			budget: cap.budget,
			nextFreeMin: cap.nextFreeMin,
		}
	}

	private capacityView(atMin: number): LedgerView {
		return {
			foreign: null,
			inUse: this.heldAt(atMin),
			budget: this.cfg.budget,
			nextFreeMin: this.nextFreeAt(atMin),
		};
	}

	private bump(key: string): number {
		const n = (this.attempts.get(key) ?? 0) + 1;
		this.attempts.set(key, n);
		return n;
	}

	private prune(t: number): void {
		if (this.leases.some((l) => l.until <= t)) {
			this.leases = this.leases.filter((l) => l.until > t);
		}
	}
}

function topicKey(topic: ConsultTopic): string {
	return topic.kind === "claims" ? `claims:${topic.scope}` : "capacity";
}
