// hooks/lib/federation/consult-expiry.ts — W611 (W436 item 4): consults get deadlines.
// An OPEN consult undelivered past its deadline expires — the asker's lane
// must learn the answer is never coming, not wait on a ghost expert. Expiry
// marks the row EXPIRED and emits a `consult.expired` event targeted at the
// asker, so the W611 gate drain (lane-inbox.ts) delivers the news mid-work.
// Consumers: coord gc (facts.ts) and the store-server's periodic sweep —
// the hub owns the clock, a manual gc is only the backstop.
import type { Database } from "../../coord/shared.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { ensureConsultReaders } from "../consult/consult-readers.ts";

// Same TTL the gc has always used for OPEN consults (facts.ts, 1h) — the
// LEGACY bound: consults without W2866 reader rows keep it. Reader-set
// consults ride the per-reader 24h last resort instead (consult-readers.ts):
// no global TTL while any reader still owes an answer.
export const CONSULT_TTL_MS = 3_600_000;
export const CONSULT_READER_TTL_MS = 86_400_000;

/** Deadline for a consult created at `createdAt` — the INSERT always stamps
 * this explicitly; COALESCE covers pre-W611 rows whose column is NULL. */
export const consultDeadline = (createdAt: number): number =>
	createdAt + CONSULT_TTL_MS;

/** Expire every OPEN consult past its deadline. Returns the count expired.
 * Each expiry emits one `consult.expired` event targeted at the asker (the
 * gate drain renders it like any other directed event). Fail-open: callers
 * run this on hot paths — a throwing sweep must never take the gc or the
 * store-server's tick down with it. */
export function expireConsults(db: Database, now = Date.now()): number {
	try {
		// the NOT IN subquery below needs the table to exist even on a store
		// that has never fanned out a reader row — ensure BEFORE the first read
		const g = db as unknown as GovernorStore;
		ensureConsultReaders(g);
		const due = db
			.query(
				"SELECT id, asker_sid, question, scope FROM consults WHERE state = 'OPEN' AND COALESCE(deadline_at, created_at + ?) <= ? AND id NOT IN (SELECT consult_id FROM consult_readers)",
			)
			.all(CONSULT_TTL_MS, now) as {
			id: number;
			asker_sid: string;
			question: string;
			scope: string | null;
		}[];
		const stamp = db.query(
			"UPDATE consults SET state = 'EXPIRED', answered_at = ? WHERE state = 'OPEN' AND id = ?",
		);
		const emit = db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'consult.expired', ?, ?, ?)",
		);
		for (const c of due) {
			stamp.run(now, c.id);
			emit.run(
				now,
				c.scope,
				JSON.stringify({
					consult: `C${c.id}`,
					reason: `expired unanswered after ${CONSULT_TTL_MS / 60_000}min`,
					q: c.question,
				}),
				c.asker_sid,
			);
		}
		// W2866 phase 2 — reader-set consults: no global TTL; the per-reader
		// 24h last resort flips individual still-unanswered reader rows and
		// notifies the asker per flipped reader.
		const stale = g
			.query(
				"SELECT r.consult_id, r.reader_sid, c.scope, c.asker_sid, c.question FROM consult_readers r JOIN consults c ON c.id = r.consult_id WHERE r.state IN ('unread', 'reading') AND r.updated_at < ? AND c.state IN ('OPEN', 'QUEUED')",
			)
			.all(now - CONSULT_READER_TTL_MS) as {
			consult_id: number;
			reader_sid: string;
			scope: string | null;
			asker_sid: string;
			question: string;
		}[];
		if (stale.length) {
			const flip = g.query(
				"UPDATE consult_readers SET state = 'expired', updated_at = ? WHERE consult_id = ? AND reader_sid = ? AND state IN ('unread', 'reading')",
			);
			const readerExpired = g.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'consult.reader.expired', ?, ?, ?)",
			);
			for (const r of stale) {
				flip.run(now, r.consult_id, r.reader_sid);
				readerExpired.run(
					now,
					r.scope,
					JSON.stringify({
						consult: `C${r.consult_id}`,
						reader: r.reader_sid,
						reason: "reader exceeded the 24h per-reader bound",
					}),
					r.asker_sid,
				);
			}
		}
		// a consult whose readers have ALL settled without an answer expires
		// as a whole — same consult.expired notice the legacy path emits
		const settled = db
			.query(
				"SELECT id, asker_sid, question, scope FROM consults WHERE state = 'OPEN' AND id IN (SELECT consult_id FROM consult_readers) AND NOT EXISTS (SELECT 1 FROM consult_readers r WHERE r.consult_id = consults.id AND r.state IN ('unread', 'reading'))",
			)
			.all() as {
			id: number;
			asker_sid: string;
			question: string;
			scope: string | null;
		}[];
		for (const c of settled) {
			stamp.run(now, c.id);
			emit.run(
				now,
				c.scope,
				JSON.stringify({
					consult: `C${c.id}`,
					reason:
						"all readers settled without an answer (W2866 per-reader bound)",
					q: c.question,
				}),
				c.asker_sid,
			);
		}
		return due.length + settled.length;
	} catch {
		return 0; // fail-open: the next sweep retries
	}
}
