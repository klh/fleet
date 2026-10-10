// hooks/lib/consult-expiry.ts — W611 (W436 item 4): consults get deadlines.
// An OPEN consult undelivered past its deadline expires — the asker's lane
// must learn the answer is never coming, not wait on a ghost expert. Expiry
// marks the row EXPIRED and emits a `consult.expired` event targeted at the
// asker, so the W611 gate drain (lane-inbox.ts) delivers the news mid-work.
// Consumers: coord gc (facts.ts) and the store-server's periodic sweep —
// the hub owns the clock, a manual gc is only the backstop.
import type { Database } from "../coord/shared.ts";

// Same TTL the gc has always used for OPEN consults (facts.ts, 1h).
export const CONSULT_TTL_MS = 3_600_000;

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
		const due = db
			.query(
				"SELECT id, asker_sid, question, scope FROM consults WHERE state = 'OPEN' AND COALESCE(deadline_at, created_at + ?) <= ?",
			)
			.all(CONSULT_TTL_MS, now) as {
			id: number;
			asker_sid: string;
			question: string;
			scope: string | null;
		}[];
		if (!due.length) return 0;
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
		return due.length;
	} catch {
		return 0; // fail-open: the next sweep retries
	}
}
