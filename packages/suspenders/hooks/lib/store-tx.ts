// store-tx.ts — W662: store-server tx BEGIN with marker/conn desync heal.
// The in-memory tx marker and the tx connection desync when a rollback
// failure is swallowed (idle sweep, commit catch): the marker says "no tx"
// while the connection is actually inside one. The next BEGIN IMMEDIATE
// then throws "cannot start a transaction within a transaction" — unhandled,
// that 500'd every tx-mode write fleet-wide until a restart (2026-10-11
// outage). beginWithHeal probes the real connection state via that error,
// kills the orphan, and re-begins. Exported for unit tests: the server's tx
// state is process-local and cannot be wire-injected.
import type { GovernorStore } from "./govdb.ts";

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
