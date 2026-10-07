// packages/blam/bench/consult/plane.ts — the scripted consult plane:
// experts, delivery health, and the verified knowledge base. No model
// calls; every outcome is a function of the config and attempt number.
import type { AskOutcome, KbRow, PlaneConfig } from "./types.ts";

export interface KbHit {
	row: KbRow;
	/** row version differs from the plane's currentVersion */
	stale: boolean;
}

/**
 * Consult plane under test. One instance per scenario run; attempts are
 * numbered per (scope, taskId) so delivery injection is deterministic:
 * "drop-first" fails the first attempt for every scope, "drop-all" fails
 * every attempt (no-expert scopes are unaffected).
 */
export class ConsultPlane {
	private readonly cfg: PlaneConfig;
	private readonly attempts = new Map<string, number>();

	constructor(cfg: PlaneConfig) {
		this.cfg = cfg;
	}

	private scopeHasLiveExpert(scope: string): boolean {
		return this.cfg.experts.some((e) => e.scope === scope && e.live);
	}

	private deliveryFails(scope: string, taskId: string): boolean {
		if (this.cfg.delivery === "ok") return false;
		const key = `${scope}\u0000${taskId}`;
		const n = this.attempts.get(key) ?? 0;
		if (this.cfg.delivery === "drop-first" && n > 1) return false;
		return true;
	}

	private bump(scope: string, taskId: string): void {
		const key = `${scope}\u0000${taskId}`;
		this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
	}

	/** KB retrieval: verified rows only, staleness reported, never hidden. */
	kbLookup(scope: string): KbHit | null {
		const row = this.cfg.kb.find(
			(r) => r.scope === scope && r.verified,
		);
		if (!row) return null;
		return {
			row,
			stale: row.codeVersion !== this.cfg.currentVersion,
		};
	}

	/**
	 * One consult attempt. Outcome order mirrors the real gate: liveness,
	 * then delivery, then answer quality.
	 */
	ask(taskId: string, scope: string): AskOutcome {
		if (!this.scopeHasLiveExpert(scope)) return { kind: "no-expert" };
		this.bump(scope, taskId);
		if (this.deliveryFails(scope, taskId)) return { kind: "undelivered" };
		// Scripted experts answer with evidence when asked within scope.
		return { kind: "answered", useful: true };
	}
}
