// store-tx.ts — W662: store-server tx BEGIN with marker/conn desync heal.
// The in-memory tx marker and the tx connection desync when a rollback
// failure is swallowed (idle sweep, commit catch): the marker says "no tx"
// while the connection is actually inside one. The next BEGIN IMMEDIATE
// then throws "cannot start a transaction within a transaction" — unhandled,
// that 500'd every tx-mode write fleet-wide until a restart (2026-10-11
// outage). beginWithHeal probes the real connection state via that error,
// kills the orphan, and re-begins. Exported for unit tests: the server's tx
// state is process-local and cannot be wire-injected.
import type { GovernorStore } from "../govdb/govdb.ts";

// the one SQLite message that means "the connection, not the marker, is
// the source of truth right now" — everything else is a real begin failure
const IN_TX_RE = /within a transaction/i;

export type BeginResult = { ok: true } | { err: string };

export function beginWithHeal(conn: GovernorStore): BeginResult {
	let msg = "";
	try {
		conn.run("BEGIN IMMEDIATE");
	} catch (e) {
		msg = String(e);
		if (!IN_TX_RE.test(msg)) return { err: `begin failed: ${msg}` };
		// orphan transaction: the owner's marker was already gone before this
		// begin (nothing live can be rolled back) — kill it and re-begin.
		try {
			conn.run("ROLLBACK");
		} catch {}
		try {
			conn.run("BEGIN IMMEDIATE");
		} catch (e2) {
			return { err: `begin failed: ${String(e2)}` };
		}
	}
	return { ok: true };
}

// ─── W978 stale write-txn watchdog ───────────────────────────────────────────
// The 2026-10-20 incident: a write lock held ~30min while reads kept flowing
// (WAL) — every mutating verb's BEGIN IMMEDIATE came back "database is
// locked" and lane closes/requeues sat dead. beginWithHeal only heals the tx
// connection at the NEXT begin; these sweeps run on a timer so the store
// recovers without waiting for traffic. Payload-only returns: the caller
// (store-server) owns the store.txn-stale event insert + WS broadcast.

// the server's open-transaction cell, typed at its single source. `started`
// is the total-txn-age clock the watchdog enforces (its N seconds); `last`
// stays the idle clock rollIdle already enforces on request.
export type TxCell = {
	v: { id: string; last: number; started: number } | null;
};

export type StaleTxnEvent = {
	plane: string;
	txid: string | null;
	ageMs: number;
	reason: "stale" | "orphan";
};

// default watchdog age: a tagged tx window is a few serialized round trips
// (the server's TX_IDLE_MS=10s already rolls back idlers on request), so
// anything holding the write txn longer than this is stuck, not working.
export const TXN_STALE_MS = 30_000;

// abort a tracked tx window past its total age: rollback + clear the cell,
// report the event. Never throws — a failed rollback must not kill the timer
// that would retry the sweep anyway.
export function sweepStaleTxn(opts: {
	label: string;
	cell: TxCell;
	txConn: GovernorStore;
	maxAgeMs?: number;
	now?: number;
}): StaleTxnEvent | null {
	const t = opts.cell.v;
	if (!t) return null;
	const ageMs = (opts.now ?? Date.now()) - t.started;
	if (ageMs <= (opts.maxAgeMs ?? TXN_STALE_MS) || ageMs < 0) return null;
	try {
		opts.txConn.run("ROLLBACK");
	} catch {}
	opts.cell.v = null;
	return {
		plane: opts.label,
		txid: t.id === "?" ? null : t.id,
		ageMs,
		reason: "stale",
	};
}

// orphan probe for the plane's MAIN connection (the one no cell tracks):
// BEGIN IMMEDIATE — "within a transaction" means an untracked write txn is
// wedged here (a rollback swallowed somewhere upstream); kill it. "database
// is locked" means a live window or an external process holds the lock —
// nothing of ours to abort.
export function sweepOrphanTxn(opts: {
	label: string;
	conn: GovernorStore;
	now?: number;
}): StaleTxnEvent | null {
	let began = false;
	try {
		opts.conn.run("BEGIN IMMEDIATE");
		began = true;
	} catch (e) {
		if (!IN_TX_RE.test(String(e))) return null;
	}
	if (began) {
		try {
			opts.conn.run("ROLLBACK");
		} catch {}
		return null;
	}
	try {
		opts.conn.run("ROLLBACK");
	} catch {}
	return {
		plane: opts.label,
		txid: null,
		ageMs: 0,
		reason: "orphan",
	};
}
