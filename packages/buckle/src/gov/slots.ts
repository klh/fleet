// src/gov/slots.ts — W468 admission control: bounded simultaneous
// generations. One global pool plus a per-team share. W1118: ownership is
// EXACT — every acquisition inserts per-holder rows (scope × unique holder
// id) inside BEGIN IMMEDIATE (the same single-writer serialization the
// budgets use — two replicas cannot both take the last slot), and release
// deletes those rows. The lease sweep removes whole dead-holder rows: one
// live stream is never reclaimed because a DIFFERENT holder's aggregate
// touched stamp aged out (the W1118 repro — aggregate held+touched reset a
// live slot after the lease). A holder that dies without releasing is
// reclaimed once its own row ages past the lease. 0 disables a pool.
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

const COUNT_SCOPE =
	"SELECT COUNT(*) AS n FROM admission_slot_holders WHERE scope = ?";

const INSERT_HOLDER =
	"INSERT INTO admission_slot_holders (scope, holder, touched) VALUES (?, ?, ?)";

const DELETE_HOLDER =
	"DELETE FROM admission_slot_holders WHERE scope = ? AND holder = ?";

const TOUCH_HOLDER =
	"UPDATE admission_slot_holders SET touched = ? WHERE scope = ? AND holder = ?";

/** Dead-holder sweep: rows whose absolute sweep deadline has passed
 *  return to the pool. Per-holder rows — a live stream that renews (or
 *  holds) is never swept; a crashed holder is reclaimed at its deadline. */
const SWEEP_DEAD = "DELETE FROM admission_slot_holders WHERE touched <= ?";

/** The lease one admitted request holds: renew() keeps the holder rows
 *  alive past the sweep (stream chunks) — W1118 #55606: a quiet stream
 *  with NO chunks past leaseMs must not be swept either, so acquire()
 *  takes an absolute deadline; hold(deadlineMs) moves that deadline once
 *  (bounded, per renewal). release() deletes the rows; after release
 *  every call is a no-op. */
export interface SlotLease {
	renew(): void;
	/** Push the sweep deadline out (the lease holds at least this long
	 *  even with zero chunks). One call per renewal keeps a client that
	 *  stalls forever from pinning the slot forever. */
	hold(deadlineMs: number): void;
	release(): void;
}

/** Slot pools disabled (0 caps): every acquire succeeds with a no-op
 *  lease, the call shape the gate can treat uniformly. */
const NOOP_LEASE: SlotLease = {
	renew: () => {},
	hold: () => {},
	release: () => {},
};

export class Slots {
	constructor(
		private readonly db: Database,
		private readonly limits: SlotLimits,
		private readonly now: () => number = Date.now,
		readonly leaseMs = 120_000,
	) {}

	get enabled(): boolean {
		return this.limits.global > 0 || this.limits.perTeam > 0;
	}

	/** Take one slot for the principal (global pool, plus its team share).
	 *  False = both/either pool full — the caller answers 429. The lease
	 *  holds until `holdUntil` (an absolute ms deadline, defaulting to
	 *  now + leaseMs) — a quiet stream renews by calling hold() again. */
	acquire(team: string | null, holdUntil?: number): SlotLease | null {
		if (!this.enabled) return NOOP_LEASE;
		const t = this.now();
		const holder = `h${t.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const scopes: string[] = [SCOPE_GLOBAL];
		if (team !== null && this.limits.perTeam > 0) scopes.push(teamScope(team));
		this.db.exec("BEGIN IMMEDIATE");
		try {
			// W1118 #55606: touched IS the absolute sweep deadline. Sweep first:
			// rows whose deadline has passed return to the pool.
			this.db.query(SWEEP_DEAD).run(t);
			const deadline = Math.max(t + this.leaseMs, holdUntil ?? 0);
			this.db.query(INSERT_HOLDER).run(SCOPE_GLOBAL, holder, deadline);
			const g = this.db.query(COUNT_SCOPE).get(SCOPE_GLOBAL) as { n: number };
			if (this.limits.global > 0 && g.n > this.limits.global) {
				this.db.exec("ROLLBACK");
				return null;
			}
			if (scopes.length > 1) {
				const scope = scopes[1] as string;
				this.db.query(INSERT_HOLDER).run(scope, holder, deadline);
				const tr = this.db.query(COUNT_SCOPE).get(scope) as { n: number };
				if (tr.n > this.limits.perTeam) {
					this.db.exec("ROLLBACK");
					return null;
				}
			}
			this.db.exec("COMMIT");
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* the failed statement already unwound */
			}
			throw e;
		}
		let released = false;
		let deadline = Math.max(t + this.leaseMs, holdUntil ?? 0);
		return {
			release: () => {
				// W1118 #55798: `released` flips only AFTER a committed DELETE —
				// a failed tx leaves the flag false so the next settle path
				// (flush/cancel/abort) retries; the rows also age out at the
				// sweep deadline either way. Never throws into a settle path.
				if (released) return;
				this.db.exec("BEGIN IMMEDIATE");
				try {
					for (const scope of scopes)
						this.db.query(DELETE_HOLDER).run(scope, holder);
					this.db.exec("COMMIT");
					released = true;
				} catch (e) {
					try {
						this.db.exec("ROLLBACK");
					} catch {
						/* already unwound */
					}
					console.error(
						`buckle: slot release failed (holder=${holder}), retained for retry: ${String(e)}`,
					);
				}
			},
			// W1118 #55606: touched stores the absolute sweep DEADLINE — renew
			// writes now + leaseMs, never bare now (a bare now would let the
			// very next acquire sweep this live holder). hold() re-arms the
			// deadline forward for a quiet stream: one bounded push per call.
			renew: () => {
				if (released) return;
				deadline = this.now() + this.leaseMs;
				for (const scope of scopes)
					this.db.query(TOUCH_HOLDER).run(deadline, scope, holder);
			},
			hold: (untilMs: number) => {
				if (released) return;
				deadline = Math.max(deadline, this.now() + Math.max(0, untilMs));
				for (const scope of scopes)
					this.db.query(TOUCH_HOLDER).run(deadline, scope, holder);
			},
		};
	}

	/** Give the slot back (response settled — success, denial or throw). */
	release(lease?: SlotLease): void {
		lease?.release();
	}

	/** Readback for admin/tests: live pool depth. */
	held(): { global: number; teams: Record<string, number> } {
		const rows = this.db
			.query(
				"SELECT scope, COUNT(*) AS n FROM admission_slot_holders GROUP BY scope",
			)
			.all() as Array<{ scope: string; n: number }>;
		const out: { global: number; teams: Record<string, number> } = {
			global: 0,
			teams: {},
		};
		for (const r of rows) {
			if (r.scope === SCOPE_GLOBAL) out.global = r.n;
			else if (r.scope.startsWith("team:")) out.teams[r.scope.slice(5)] = r.n;
		}
		return out;
	}
}
