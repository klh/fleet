// Bounded, read-only export of the hub's projected CloudEvents. The admin
// gate authenticates callers; the cursor is local SQLite insertion order,
// while source+id remain the durable cross-hub deduplication key.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Observation } from "./observe.ts";

const MAX_EVENTS = 64;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface ObservationExport {
	events: Observation[];
	/** First retained event identifies the projection generation after reset. */
	generation: string | null;
	nextCursor: number;
	maxCursor: number;
	hasMore: boolean;
}

export function exportObservations(
	path: string,
	cursor: number,
	limit = MAX_EVENTS,
): ObservationExport {
	if (!Number.isSafeInteger(cursor) || cursor < 0)
		throw new Error("Invalid observation cursor");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS)
		throw new Error("Invalid observation limit");
	if (!existsSync(path)) throw new Error("Observation projection unavailable");
	const db = new Database(path, { readonly: true });
	try {
		const first = db
			.query("SELECT source, id, time FROM obs_events ORDER BY rowid LIMIT 1")
			.get() as { source: string; id: string; time: string } | null;
		const generation = first
			? `${first.source}/${first.id}/${first.time}`
			: null;
		const maxCursor =
			(
				db.query("SELECT MAX(rowid) AS value FROM obs_events").get() as {
					value: number | null;
				}
			).value ?? 0;
		// A hub projection may be recreated. The receiver deduplicates by
		// source+id when it sees this cursor rewind.
		const after = cursor > maxCursor ? 0 : cursor;
		const rows = db
			.query(
				"SELECT rowid AS cursor, source, id, type, time, data FROM obs_events WHERE rowid > ? ORDER BY rowid LIMIT ?",
			)
			.all(after, limit + 1) as Array<{
			cursor: number;
			source: string;
			id: string;
			type: Observation["type"];
			time: string;
			data: string;
		}>;
		const events: Observation[] = [];
		let bytes = 0;
		let nextCursor = after;
		for (const row of rows.slice(0, limit)) {
			bytes += row.data.length + row.source.length + row.id.length + 128;
			if (bytes > MAX_RESPONSE_BYTES)
				throw new Error("Observation page exceeds transfer limit");
			events.push({
				specversion: "1.0",
				source: row.source,
				id: row.id,
				type: row.type,
				time: row.time,
				data: JSON.parse(row.data) as Observation["data"],
			});
			nextCursor = row.cursor;
		}
		return {
			events,
			generation,
			nextCursor,
			maxCursor,
			hasMore: rows.length > limit,
		};
	} finally {
		db.close();
	}
}
