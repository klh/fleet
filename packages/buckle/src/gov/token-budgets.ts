// src/gov/token-budgets.ts — W2790 per-key MONTHLY token budgets with
// warn-then-cap. Subjects are credential identity axes from api_keys: the
// mint NAME (exact row first, then the longest `prefix*` row) or the actor
// (`actor:<id>` rows); a root bearer has no api_keys row and is unlimited
// by construction (break-glass). Ceiling = weighted tokens per calendar
// month (UTC); operator unset = unlimited, so lanes keep working — the
// feature targets shared/employee-facing deployments (Azure W2783) where
// fair-use spend control is the point.
//
// Bookkeeping follows the W843 spend doctrine: admission reserves the
// input estimate (ceil(bodyBytes/4) × model weight) in one BEGIN IMMEDIATE
// transaction, settle adds the real reported usage — the book errs high
// (a delivered request counts its input twice), never under. Strictly-over
// denies (429 buckle.budget_exceeded via the wire deny() seam — the W2618
// admission-deny keyed shape, zero outbound); ≥80% of the ceiling warns
// via the x-klh-budget response header (stamped in wire-stamp) and the
// admin report. State rows exist ONLY for budgeted subjects — unbudgeted
// keys never touch the table.
//
// Layering: process-global engine (the occupancy.ts precedent) configured
// by the Governance constructor AFTER applyGovernanceSchema; the proxy
// ingress checks, usage-record settles, admin mutates. No env knobs —
// budgets are admin-API + DB rows (config-over-code).
import type { Database } from "bun:sqlite";

/** A configured budget row (weights already parsed). */
export interface TokenBudgetRow {
	subject: string;
	monthlyTokens: number;
	weights: Record<string, number>;
	updatedAt: number;
}

/** The ingress verdict — "unlimited" carries no subject (nothing stashes). */
export type TokenBudgetVerdict =
	| { status: "unlimited" }
	| {
			status: "ok";
			subject: string;
			used: number;
			ceiling: number;
			pct: number;
			warn: boolean;
	  }
	| {
			status: "denied";
			subject: string;
			used: number;
			ceiling: number;
			retryAfterS: number;
			resetIso: string;
	  };

/** Calendar month id in UTC: `YYYY-MM`. */
export function monthOf(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 7);
}

/** Seconds until the current UTC month rolls over (>=1). */
export function monthEndRemainderS(nowMs: number): number {
	const d = new Date(nowMs);
	const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
	return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

// ─── process-global state (the occupancy.ts precedent) ──────────────────────

let db: Database | null = null;
let cache = new Map<string, TokenBudgetRow>();

const RESERVE = `INSERT INTO token_budget_state (month, subject, used_tok, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(month, subject) DO UPDATE SET
  used_tok = used_tok + excluded.used_tok,
  updated_at = excluded.updated_at`;

const READ_STATE = `SELECT used_tok FROM token_budget_state WHERE month = ? AND subject = ?`;

/** Governance constructor hook: bind the authority + load the row cache. */
export function configureTokenBudgets(authority: Database): void {
	db = authority;
	cache = loadRows(authority);
}

function loadRows(authority: Database): Map<string, TokenBudgetRow> {
	const out = new Map<string, TokenBudgetRow>();
	const rows = authority
		.query(
			"SELECT subject, monthly_tokens, weights, updated_at FROM token_budgets",
		)
		.all() as Array<{
		subject: string;
		monthly_tokens: number;
		weights: string;
		updated_at: number;
	}>;
	for (const r of rows) {
		out.set(r.subject, {
			subject: r.subject,
			monthlyTokens: r.monthly_tokens,
			weights: parseWeights(r.subject, r.weights),
			updatedAt: r.updated_at,
		});
	}
	return out;
}

/** Weights are JSON (config-over-code); a malformed row logs and degrades
 *  to weight-1 for everything — throttle config never takes the gate down. */
function parseWeights(subject: string, raw: string): Record<string, number> {
	if (raw === "{}" || raw === "") return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(parsed))
			if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
		return out;
	} catch (e) {
		console.error(
			`buckle: token_budgets weights for '${subject}' are not valid JSON — weights INERT (${String(e)})`,
		);
		return {};
	}
}

/** The configured budget for a credential, or null = unlimited.
 *  Precedence: exact mint name → longest name prefix (`prefix*`) → actor. */
export function resolveTokenBudget(
	name: string | null,
	actor: string | null,
): TokenBudgetRow | null {
	if (name !== null && name.length > 0) {
		const exact = cache.get(name);
		if (exact !== undefined) return exact;
		let best: TokenBudgetRow | null = null;
		for (const row of cache.values()) {
			if (!row.subject.endsWith("*")) continue;
			const prefix = row.subject.slice(0, -1);
			if (!name.startsWith(prefix)) continue;
			if (best === null || prefix.length > best.subject.length - 1) best = row;
		}
		if (best !== null) return best;
	}
	if (actor !== null && actor.length > 0)
		return cache.get(`actor:${actor}`) ?? null;
	return null;
}

/** The weight a model_group carries under a budget (default 1). */
export function weightOf(row: TokenBudgetRow, group: string): number {
	return row.weights[group] ?? 1;
}

/** Ingress admission: reserve the weighted input estimate for the current
 *  month inside one immediate transaction, enforce the ceiling against the
 *  post-reservation sum. Denial rolls the reservation back (no residue) and
 *  carries retry-after = the month remainder (clamped by the caller — a
 *  quota wall must never sleep a client for weeks). Unlimited subjects
 *  never touch the table. Unconfigured engine (no governance) = unlimited;
 *  the identity axes come from the authenticated Principal (name/actor). */
export function checkTokenBudget(
	ident: { name: string | null; actor: string | null } | null,
	group: string,
	bodyBytes: number,
	nowMs: number = Date.now(),
): TokenBudgetVerdict {
	if (db === null) return { status: "unlimited" };
	if (ident === null) return { status: "unlimited" };
	const row = resolveTokenBudget(ident.name, ident.actor);
	if (row === null) return { status: "unlimited" };
	const w = weightOf(row, group);
	const est = Math.ceil(bodyBytes / 4) * w;
	const month = monthOf(nowMs);
	db.exec("BEGIN IMMEDIATE");
	let used: number;
	try {
		db.query(RESERVE).run(month, row.subject, est, nowMs);
		used = (
			db.query(READ_STATE).get(month, row.subject) as { used_tok: number }
		).used_tok;
		if (used > row.monthlyTokens) {
			db.exec("ROLLBACK");
			return {
				status: "denied",
				subject: row.subject,
				used,
				ceiling: row.monthlyTokens,
				retryAfterS: monthEndRemainderS(nowMs),
				resetIso: new Date(nowMs + monthEndRemainderS(nowMs) * 1000)
					.toISOString()
					.slice(0, 16),
			};
		}
		db.exec("COMMIT");
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* the failed statement already unwound */
		}
		throw e;
	}
	const pct = Math.round((used / row.monthlyTokens) * 100);
	return {
		status: "ok",
		subject: row.subject,
		used,
		ceiling: row.monthlyTokens,
		pct,
		warn: used >= row.monthlyTokens * 0.8,
	};
}

/** Settle: add the real reported usage (weighted) to the month book. Only
 *  budgeted subjects write — the reservation from ingress already holds
 *  the estimate (W843 errs-high doctrine). */
export function settleTokenBudget(
	subject: string,
	group: string,
	tokens: number,
	nowMs: number = Date.now(),
): void {
	if (db === null || tokens <= 0) return;
	const row = cache.get(subject);
	if (row === undefined) return;
	db.query(RESERVE).run(
		monthOf(nowMs),
		subject,
		tokens * weightOf(row, group),
		nowMs,
	);
}

/** Admin: upsert one budget row (weights stringified by the route). */
export function setTokenBudget(spec: {
	subject: string;
	monthlyTokens: number;
	weights: Record<string, number>;
}): void {
	if (db === null) return;
	db.query(
		`INSERT INTO token_budgets (subject, monthly_tokens, weights, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(subject) DO UPDATE SET
		   monthly_tokens = excluded.monthly_tokens,
		   weights = excluded.weights,
		   updated_at = excluded.updated_at`,
	).run(
		spec.subject,
		spec.monthlyTokens,
		JSON.stringify(spec.weights),
		Date.now(),
	);
	cache = loadRows(db);
}

/** Admin: drop one budget row (the subject returns to unlimited). */
export function deleteTokenBudget(subject: string): boolean {
	if (db === null) return false;
	const n = db
		.query("DELETE FROM token_budgets WHERE subject = ?")
		.run(subject).changes;
	cache = loadRows(db);
	return n > 0;
}

/** Admin/report read-back: rows joined with the current month's usage. */
export function listTokenBudgets(nowMs: number = Date.now()): Array<
	TokenBudgetRow & {
		month: string;
		usedTok: number;
		pct: number;
		warn: boolean;
	}
> {
	const month = monthOf(nowMs);
	const out: Array<
		TokenBudgetRow & {
			month: string;
			usedTok: number;
			pct: number;
			warn: boolean;
		}
	> = [];
	for (const row of [...cache.values()].sort((a, b) =>
		a.subject < b.subject ? -1 : 1,
	)) {
		const st = db?.query(READ_STATE).get(month, row.subject) as {
			used_tok: number;
		} | null;
		const usedTok = st?.used_tok ?? 0;
		out.push({
			...row,
			month,
			usedTok,
			pct: Math.round((usedTok / row.monthlyTokens) * 100),
			warn: usedTok >= row.monthlyTokens * 0.8,
		});
	}
	return out;
}

/** Test seam: unbind + clear (module-global reset). */
export function resetTokenBudgetsForTest(): void {
	db = null;
	cache = new Map();
}
