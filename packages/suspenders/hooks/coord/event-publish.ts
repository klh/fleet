import type { GovernorStore } from "../lib/govdb-store.ts";

export interface EventPublication {
	kind: string;
	scope?: string | null;
	sha?: string | null;
	note?: string | null;
	source: string;
	to?: string | null;
	extra?: Record<string, string>;
}

/** The shared durable write, on the caller's store and transaction. */
export function emitStoredEvent(
	db: GovernorStore,
	project: string,
	opts: EventPublication,
): number {
	const payload = JSON.stringify({
		project,
		...(opts.sha ? { sha: opts.sha } : {}),
		...(opts.note ? { note: opts.note } : {}),
		...(opts.extra ?? {}),
	});
	// W1261: the INSERT's own StoreResult carries the rowid on BOTH transports.
	// A follow-up SELECT last_insert_rowid() is a second round trip against the
	// store server's ONE shared connection — per-connection state any
	// interleaved writer (or the concurrent twin message) overwrites, which
	// resolved two distinct directed messages to one event id (#67715).
	const r = db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			Date.now(),
			opts.source,
			opts.kind,
			opts.scope ?? null,
			payload,
			opts.to ?? null,
		);
	return Number(r.lastInsertRowid);
}
