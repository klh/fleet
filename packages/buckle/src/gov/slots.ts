// src/gov/slots.ts — W468 admission control: bounded simultaneous
// generations. One global pool plus a per-team share, both held as rows in
// admission_slots acquired inside BEGIN IMMEDIATE (the same single-writer
// serialization the budgets use — two replicas cannot both take the last
// slot) and released when the response settles. A holder that dies without
// releasing is reclaimed once its touched stamp ages past the lease, so a
// crashed replica cannot permanently leak the pool. 0 disables a pool.
import type { Database } from "bun:sqlite";

export interface SlotLimits {
	global: number;
	perTeam: number;
}

/** Config-over-code: machine config carries the real numbers; these
 *  defaults only shape a bare install. 0 disables the pool. */
export function slotsFromEnv(
	env: Record<string, string | undefined> = process.env,
): SlotLimits {
	const num = (v: string | undefined, d: number): number => {
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
	};
	return {
		global: num(env.BUCKLE_SLOTS_GLOBAL, 64),
		perTeam: num(env.BUCKLE_SLOTS_PER_TEAM, 16),
	};
}

const SCOPE_GLOBAL = "global";
const teamScope = (team: string): string => `team:${team}`;

const UPSERT_SLOT = `INSERT INTO admission_slots (scope, held, touched)
VALUES (?, 1, ?)
ON CONFLICT(scope) DO UPDATE SET
  held = held + 1,
  touched = excluded.touched`;

const READ_SLOT = "SELECT held FROM admission_slots WHERE scope = ?";

export class Slots {
	constructor(
		private readonly db: Database,
		private readonly limits: SlotLimits,
		private readonly now: () => number = Date.now,
		private readonly leaseMs = 120_000,
	) {}

	get enabled(): boolean {
		return this.limits.global > 0 || this.limits.perTeam > 0;
	}

	/** Take one slot for the principal (global pool, plus its team share).
	 *  False = both/either pool full — the caller answers 429. */
	acquire(team: string | null): boolean {
		if (!this.enabled) return true;
		const t = this.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			// lease sweep first: dead holders return to the pool
			this.db
				.query("UPDATE admission_slots SET held = 0 WHERE touched < ?")
				.run(t - this.leaseMs);
			this.db.query(UPSERT_SLOT).run(SCOPE_GLOBAL, t);
			const g = this.db.query(READ_SLOT).get(SCOPE_GLOBAL) as {
				held: number;
			};
			if (this.limits.global > 0 && g.held > this.limits.global) {
				this.db.exec("ROLLBACK");
				return false;
			}
			if (team !== null && this.limits.perTeam > 0) {
				const scope = teamScope(team);
				this.db.query(UPSERT_SLOT).run(scope, t);
				const tr = this.db.query(READ_SLOT).get(scope) as {
					held: number;
				};
				if (tr.held > this.limits.perTeam) {
					this.db.exec("ROLLBACK");
					return false;
				}
			}
			this.db.exec("COMMIT");
			return true;
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* the failed statement already unwound */
			}
			throw e;
		}
	}

	/** Give the slot back (response settled — success, denial or throw). */
	release(team: string | null): void {
		if (!this.enabled) return;
		const t = this.now();
		const dec =
			"UPDATE admission_slots SET held = max(0, held - 1), touched = ? WHERE scope = ?";
		this.db.query(dec).run(t, SCOPE_GLOBAL);
		if (team !== null) this.db.query(dec).run(t, teamScope(team));
	}

	/** Readback for admin/tests: live pool depth. */
	held(): { global: number; teams: Record<string, number> } {
		const rows = this.db
			.query("SELECT scope, held FROM admission_slots WHERE held > 0")
			.all() as Array<{ scope: string; held: number }>;
		const out: { global: number; teams: Record<string, number> } = {
			global: 0,
			teams: {},
		};
		for (const r of rows) {
			if (r.scope === SCOPE_GLOBAL) out.global = r.held;
			else if (r.scope.startsWith("team:"))
				out.teams[r.scope.slice(5)] = r.held;
		}
		return out;
	}
}
