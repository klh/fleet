// src/gov/budgets.ts — W468 replica-safe budgets: the DB row IS the budget
// authority. Admission reserves input + bounded output inside one
// BEGIN IMMEDIATE transaction (upsert-ADD into budget_state plus the W468
// team_budget_state aggregate), reads back the post-reservation counts and
// enforces the key limit and the team ceiling against those; a denial
// ROLLBACKs, so two processes sharing one DB file serialize on SQLite's
// single-writer lock and can no longer multiply a team's quota the way the
// W141 in-process counters (periodic 5s flush) allowed. The W141
// admission approximation (input reservation = ceil(bodyBytes/4)) stands.
import type { Database } from "bun:sqlite";

export interface BudgetLimits {
	rpm: number | null;
	tpm: number | null;
}

/** Minute-window id: `YYYY-MM-DDTHH:MM` in UTC. */
export function windowOf(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 16);
}

/** Seconds until the current minute window rolls over (>=1, jitter added by
 *  the caller per the LiteLLM retry-after pattern). */
export function windowRemainderS(nowMs: number): number {
	const s = nowMs / 1000;
	return Math.max(1, Math.ceil(60 - (s % 60)));
}

/** What admission saw, for the http-citizenship rate-limit trio: usage
 *  AFTER this request's reservation, and the window's honest edges. */
export interface BudgetView {
	usedReqs: number;
	usedTks: number;
	/** Seconds until the minute window rolls (>=1). */
	resetS: number;
	/** Unix epoch seconds of the window's end (de-facto x- family). */
	resetEpochS: number;
}

/** Effective limit = min(key limit, team ceiling); null = unbounded. */
export function effectiveLimit(
	key: BudgetLimits,
	ceiling: BudgetLimits | null,
): BudgetLimits {
	const minN = (a: number | null, b: number | null): number | null =>
		a === null ? b : b === null ? a : Math.min(a, b);
	return {
		rpm: minN(key.rpm, ceiling?.rpm ?? null),
		tpm: minN(key.tpm, ceiling?.tpm ?? null),
	};
}

const UPSERT_KEY = `INSERT INTO budget_state (
  key_id, window, used_rpm, used_tpm, cache_r, cache_c, window_start
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key_id, window) DO UPDATE SET
  used_rpm = used_rpm + excluded.used_rpm,
  used_tpm = used_tpm + excluded.used_tpm,
  cache_r = cache_r + excluded.cache_r,
  cache_c = cache_c + excluded.cache_c,
  window_start = excluded.window_start`;

const UPSERT_KEY_REQ = `INSERT INTO budget_state (
  key_id, window, used_rpm, used_tpm, window_start
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(key_id, window) DO UPDATE SET
  used_rpm = used_rpm + excluded.used_rpm,
  used_tpm = used_tpm + excluded.used_tpm,
  window_start = excluded.window_start`;

const UPSERT_TEAM = `INSERT INTO team_budget_state (
  team_id, window, used_rpm, used_tpm, window_start
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(team_id, window) DO UPDATE SET
  used_rpm = used_rpm + excluded.used_rpm,
  used_tpm = used_tpm + excluded.used_tpm,
  window_start = excluded.window_start`;

const READ_KEY = `SELECT used_rpm, used_tpm FROM budget_state
WHERE key_id = ? AND window = ?`;

const READ_TEAM = `SELECT used_rpm, used_tpm FROM team_budget_state
WHERE team_id = ? AND window = ?`;

interface Counts {
	used_rpm: number;
	used_tpm: number;
}

/** Did this reservation push the window over `limits`? The rows already
 *  carry the reservation, so "over" is strictly-greater. */
function over(limits: BudgetLimits, c: Counts): boolean {
	return (
		(limits.rpm !== null && c.used_rpm > limits.rpm) ||
		(limits.tpm !== null && c.used_tpm > limits.tpm)
	);
}

export class Budgets {
	constructor(
		private readonly db: Database,
		private readonly now: () => number = Date.now,
	) {}

	/** Atomic admission: reserve (1 req, ceil(bodyBytes/4) tks) on the key
	 *  row and the team aggregate row in one immediate transaction, read
	 *  both back, enforce key limit + team ceiling. Denial rolls the
	 *  reservation back and returns retry-after (window remainder +
	 *  U[0,1) jitter — LiteLLM retry-after semantics); the BudgetView
	 *  carries the post-reservation counts either way so the gate stamps
	 *  the rate-limit trio without a second counter read. */
	check(
		keyId: string,
		limits: BudgetLimits,
		bodyBytes: number,
		team: { id: string; limits: BudgetLimits } | null = null,
	):
		| { ok: true; view: BudgetView }
		| { ok: false; retryAfterS: number; view: BudgetView } {
		const t = this.now();
		const win = windowOf(t);
		const estTks = Math.ceil(bodyBytes / 4);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.query(UPSERT_KEY_REQ).run(keyId, win, 1, estTks, t);
			if (team !== null)
				this.db.query(UPSERT_TEAM).run(team.id, win, 1, estTks, t);
			const kr = this.db.query(READ_KEY).get(keyId, win) as Counts;
			let denied = over(limits, kr);
			if (!denied && team !== null) {
				const tr = this.db.query(READ_TEAM).get(team.id, win) as Counts | null;
				denied = tr !== null && over(team.limits, tr);
			}
			if (denied) {
				this.db.exec("ROLLBACK");
				return {
					ok: false,
					retryAfterS: windowRemainderS(t) + Math.random(),
					view: this.view(kr, t),
				};
			}
			this.db.exec("COMMIT");
			return { ok: true, view: this.view(kr, t) };
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* the failed statement already unwound */
			}
			throw e;
		}
	}

	/** Release an admission reservation (denial after admit): the request
	 *  count drops on both the key row and the team aggregate; the input
	 *  estimate stays counted, matching W141 bookkeeping. */
	release(keyId: string, team: string | null = null): void {
		const win = windowOf(this.now());
		this.db
			.query(
				"UPDATE budget_state SET used_rpm = max(0, used_rpm - 1) WHERE key_id = ? AND window = ?",
			)
			.run(keyId, win);
		if (team !== null)
			this.db
				.query(
					"UPDATE team_budget_state SET used_rpm = max(0, used_rpm - 1) WHERE team_id = ? AND window = ?",
				)
				.run(team, win);
	}

	/** Post-response real usage — atomic upsert-ADD on the key row (W457:
	 *  provider-reported cache reads/writes ride the same row) and the
	 *  team aggregate. Replaces the W141 flush: writes land at the
	 *  authority the moment they are known. */
	addUsage(
		keyId: string,
		requests: number,
		tokens: number,
		cacheR = 0,
		cacheC = 0,
		team: string | null = null,
	): void {
		const t = this.now();
		const win = windowOf(t);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.query(UPSERT_KEY)
				.run(keyId, win, requests, tokens, cacheR, cacheC, t);
			if (team !== null)
				this.db.query(UPSERT_TEAM).run(team.id, win, requests, tokens, t);
			this.db.exec("COMMIT");
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* the failed statement already unwound */
			}
			throw e;
		}
	}

	/** Readback for admin/tests: the durable windows (the authority). */
	snapshot(): Array<{
		keyId: string;
		window: string;
		reqs: number;
		tks: number;
		cacheR: number;
		cacheC: number;
	}> {
		return this.db
			.query(
				"SELECT key_id AS keyId, window, used_rpm AS reqs, used_tpm AS tks, cache_r AS cacheR, cache_c AS cacheC FROM budget_state ORDER BY keyId, window",
			)
			.all() as Array<{
			keyId: string;
			window: string;
			reqs: number;
			tks: number;
			cacheR: number;
			cacheC: number;
		}>;
	}

	/** Admin/tests readback of the team aggregate rows. */
	snapshotTeams(): Array<{
		teamId: string;
		window: string;
		reqs: number;
		tks: number;
	}> {
		return this.db
			.query(
				"SELECT team_id AS teamId, window, used_rpm AS reqs, used_tpm AS tks FROM team_budget_state ORDER BY teamId, window",
			)
			.all() as Array<{
			teamId: string;
			window: string;
			reqs: number;
			tks: number;
		}>;
	}

	private view(c: Counts, t: number): BudgetView {
		return {
			usedReqs: c.used_rpm,
			usedTks: c.used_tpm,
			resetS: windowRemainderS(t),
			resetEpochS: Math.floor(t / 60_000) * 60 + 60,
		};
	}
}
