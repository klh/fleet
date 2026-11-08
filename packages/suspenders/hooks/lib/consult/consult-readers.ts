// hooks/lib/consult/consult-readers.ts — W2866 per-reader consult semantics:
// ONE row per (consult, reader) pair carrying unread → reading → replied /
// declined → expired, so the reader SET — not the consult row alone — owns
// the queue lifetime. While any reader still owes an answer there is NO
// global TTL: the legacy 1h sweep keeps taking no-reader rows only, and the
// per-reader 24h bound is the last resort before the asker's escalation
// notice fires. Late-join replay rides the per-reader cursor (W2869 runner).
import type { GovernorStore } from "../govdb/govdb-store.ts";

export type ReaderState =
	| "unread"
	| "reading"
	| "replied"
	| "declined"
	| "expired";

const CONSULT_READERS_DDL = `CREATE TABLE IF NOT EXISTS consult_readers (
	consult_id INTEGER NOT NULL,
	reader_sid TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'unread',
	cursor INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (consult_id, reader_sid)
)`;

// same lazy-DDL discipline as ensureConsultV2 — idempotent per handle, no
// user_version bump
const ensured = new WeakSet<object>();
export function ensureConsultReaders(db: GovernorStore): void {
	if (ensured.has(db)) return;
	db.run(CONSULT_READERS_DDL);
	ensured.add(db);
}

/** fan-out at submit: one unread row per addressed sid (kind "ask", route
 * "sid" consults only — tells/banks/fleet routes carry no reader obligation) */
export function fanOutReaders(
	db: GovernorStore,
	consultId: number,
	readerSids: readonly string[],
	now: number,
): number {
	ensureConsultReaders(db); // self-guarding producer
	const ins = db.query(
		"INSERT OR IGNORE INTO consult_readers (consult_id, reader_sid, state, cursor, updated_at) VALUES (?, ?, 'unread', 0, ?)",
	);
	let n = 0;
	for (const sid of readerSids) {
		ins.run(consultId, sid, now);
		n++;
	}
	return n;
}

/** state stamp for ONE reader; no-op when the pair has no row (legacy
 * consults keep expert_sid-only semantics) */
export function stampReader(
	db: GovernorStore,
	consultId: number,
	readerSid: string,
	state: ReaderState,
): void {
	db.query(
		"UPDATE consult_readers SET state = ?, updated_at = ? WHERE consult_id = ? AND reader_sid = ?",
	).run(state, Date.now(), consultId, readerSid);
}

/** the reader rows of one consult, alphabetical by sid */
export function readersOf(
	db: GovernorStore,
	consultId: number,
): { reader_sid: string; state: ReaderState; cursor: number }[] {
	ensureConsultReaders(db);
	return db
		.query(
			"SELECT reader_sid, state, cursor FROM consult_readers WHERE consult_id = ? ORDER BY reader_sid",
		)
		.all(consultId) as {
		reader_sid: string;
		state: ReaderState;
		cursor: number;
	}[];
}

/** the `coord consults --unread` pull face: my rows still owing an answer,
 * consult state joined in */
export function unreadFor(
	db: GovernorStore,
	readerSid: string,
): {
	id: number;
	asker_sid: string;
	question: string;
	state: string;
	reader_state: ReaderState;
}[] {
	return db
		.query(
			"SELECT c.id, c.asker_sid, c.question, c.state, r.state AS reader_state FROM consults c JOIN consult_readers r ON r.consult_id = c.id WHERE r.reader_sid = ? AND r.state IN ('unread', 'reading') ORDER BY c.id",
		)
		.all(readerSid) as {
		id: number;
		asker_sid: string;
		question: string;
		state: string;
		reader_state: ReaderState;
	}[];
}

/** best-effort terminal stamp after consult-reply/--decline: creates the
 * table if this store predates W2866, never blocks the reply */
export function stampReaderSafe(
	db: GovernorStore,
	consultId: number,
	readerSid: string,
	state: Extract<ReaderState, "replied" | "declined">,
): void {
	try {
		ensureConsultReaders(db);
		stampReader(db, consultId, readerSid, state);
	} catch {}
}

/** W2866 ack seam: an acked event whose payload carries `consult: "C##"`
 * stamps the acker's reader row `reading`. Fail-open — the stamp never
 * breaks ack, and consults without reader rows are untouched (legacy). */
export function stampConsultRead(
	db: GovernorStore,
	eventId: number,
	readerSid: string,
): boolean {
	try {
		const ev = db
			.query("SELECT payload FROM events WHERE id = ?")
			.get(eventId) as { payload: string | null } | null;
		const c = (JSON.parse(ev?.payload ?? "{}") as { consult?: unknown })
			.consult;
		if (typeof c !== "string" || !/^C\d+$/.test(c)) return false;
		ensureConsultReaders(db);
		stampReader(db, Number(c.slice(1)), readerSid, "reading");
		return true;
	} catch {
		return false;
	}
}
