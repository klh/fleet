// src/reconcile.ts — W1124.31: the supported audited reconciliation of
// abandoned inference receipts. A status-NULL route_audit receipt whose
// row PREDATES this gate incarnation (row ts < boot epoch — the process
// that accepted it is provably not this one, and one live gate owns the
// ledger) and whose age exceeds the longest live-transport bound (the
// wire total stream guard) can never settle again. It records an explicit
// abandoned/unknown verdict — status/ok stay NULL forever: no invented
// HTTP code, no retrospective provider blame, no raw-DB edit (the write
// is a supported surface riding its own proof gates). Fail-closed:
// anything unproven refuses. Immutable: a second reconcile of the same
// rid refuses — no verdict rewrites.
import type { Database } from "bun:sqlite";

/** The audited verdict stored on route_audit.reconciled. An abandoned
 *  receipt is NOT a result — status/ok stay NULL; this JSON is the only
 *  outcome the row will ever carry. */
export interface AbandonedReceipt {
	verdict: "abandoned";
	/** ISO instant of the reconcile (not the request). */
	at: string;
	/** The admin principal that drove the reconcile (hashed key id). */
	actor: string;
	/** Bounded caller-declared motive (e.g. "restart-scoped-drain"). */
	reason: string;
	/** ms from the receipt's ts to the reconcile — proof the transport
	 *  bound had elapsed. */
	age_ms: number;
	/** The reconciling gate incarnation's boot epoch ms — the
	 *  prior-incarnation proof. */
	boot_origin: number;
}

/** One reconcile request, exact-row scoped. */
export interface ReconcileInput {
	rid: string;
	/** Exact-lane guard: the row's lane must equal this, never a prefix. */
	lane: string;
	/** When present, must match the row exactly (no fuzzy neighbors). */
	trace_id?: string | null;
	/** When present, must match the row exactly. */
	ts?: string | null;
	/** The admin principal (hashed key id). */
	actor: string;
	/** Bounded motive, capped at RECONCILE_REASON_CAP. */
	reason: string;
}

/** Fail-closed verdict: ok=false carries a stable machine-readable code. */
export type ReconcileResult =
	| { ok: true; verdict: AbandonedReceipt }
	| { ok: false; code: string; why: string };

/** Bounded caller motive. */
export const RECONCILE_REASON_CAP = 200;

/** Proof context — production rides the gate's own clock/boot; tests pin
 *  both so abandonment is provable deterministically. */
export interface ReconcileProofs {
	/** Reconcile instant (epoch ms). Default Date.now(). */
	now?: number;
	/** This gate incarnation's boot epoch ms. Default performance.timeOrigin. */
	bootOrigin?: number;
	/** The longest live-transport bound (wire total stream guard, ms). */
	maxStreamMs: number;
}

/** The stored verdict JSON → typed value (null = absent/legacy/corrupt —
 *  a bad row never kills the read surface; a corrupt verdict reads as
 *  never reconciled, the fail-closed bias). */
export function parseAbandonedReceipt(raw: unknown): AbandonedReceipt | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	try {
		const j: unknown = JSON.parse(raw);
		if (!j || typeof j !== "object") return null;
		const r = j as Record<string, unknown>;
		if (r.verdict !== "abandoned") return null;
		if (typeof r.at !== "string" || typeof r.actor !== "string") return null;
		if (typeof r.reason !== "string") return null;
		if (typeof r.age_ms !== "number" || typeof r.boot_origin !== "number")
			return null;
		return {
			verdict: "abandoned",
			at: r.at,
			actor: r.actor,
			reason: r.reason,
			age_ms: r.age_ms,
			boot_origin: r.boot_origin,
		};
	} catch {
		return null;
	}
}

/** The proof-gated reconcile. Every refusal names a stable code; the write
 *  re-checks terminality under the row's rid so a concurrent settle cannot
 *  be overwritten. */
export function reconcileAbandonedReceipt(
	db: Database,
	proofs: ReconcileProofs,
	input: ReconcileInput,
): ReconcileResult {
	const row = db
		.query(
			"SELECT rid, trace_id, ts, lane, target_model, status, reconciled FROM route_audit WHERE rid = ?",
		)
		.get(input.rid) as
		| {
				rid: string;
				trace_id: string | null;
				ts: string;
				lane: string;
				target_model: string | null;
				status: number | null;
				reconciled: string | null;
		  }
		| undefined;
	if (!row)
		return {
			ok: false,
			code: "buckle.no_such_receipt",
			why: "no such receipt rid",
		};
	if (row.lane !== input.lane)
		return {
			ok: false,
			code: "buckle.receipt_lane_mismatch",
			why: "receipt lane does not match the exact-lane reconcile",
		};
	if (input.trace_id != null && input.trace_id !== row.trace_id)
		return {
			ok: false,
			code: "buckle.receipt_mismatch",
			why: "trace_id does not match the receipt",
		};
	if (input.ts != null && input.ts !== row.ts)
		return {
			ok: false,
			code: "buckle.receipt_mismatch",
			why: "ts does not match the receipt",
		};
	if (row.status !== null)
		return {
			ok: false,
			code: "buckle.receipt_settled",
			why: "receipt already settled",
		};
	if (row.reconciled !== null)
		return {
			ok: false,
			code: "buckle.receipt_reconciled",
			why: "receipt already reconciled (verdicts are immutable)",
		};
	if (row.target_model === null)
		return {
			ok: false,
			code: "buckle.receipt_not_inference",
			why: "only inference receipts reconcile (target_model present)",
		};
	const now = proofs.now ?? Date.now();
	const bootOrigin = proofs.bootOrigin ?? performance.timeOrigin;
	const tsMs = Date.parse(row.ts);
	if (!Number.isFinite(tsMs))
		return {
			ok: false,
			code: "buckle.receipt_ts_unparseable",
			why: "receipt ts is not a parseable ISO instant",
		};
	if (tsMs >= bootOrigin)
		return {
			ok: false,
			code: "buckle.receipt_live_incarnation",
			why: "receipt postdates this gate incarnation — it may be in flight here",
		};
	if (now - tsMs <= proofs.maxStreamMs)
		return {
			ok: false,
			code: "buckle.receipt_transport_bound",
			why: "receipt age is within the live-transport bound",
		};
	const verdict: AbandonedReceipt = {
		verdict: "abandoned",
		at: new Date(now).toISOString(),
		actor: input.actor,
		reason: input.reason.slice(0, RECONCILE_REASON_CAP),
		age_ms: now - tsMs,
		boot_origin: bootOrigin,
	};
	const result = db
		.query(
			"UPDATE route_audit SET reconciled = ? WHERE rid = ? AND status IS NULL AND reconciled IS NULL",
		)
		.run(JSON.stringify(verdict), input.rid);
	if (result.changes !== 1)
		return {
			ok: false,
			code: "buckle.receipt_race",
			why: "receipt changed during reconcile",
		};
	return { ok: true, verdict };
}
