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
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		Date.now(),
		opts.source,
		opts.kind,
		opts.scope ?? null,
		payload,
		opts.to ?? null,
	);
	return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
		.id;
}
