// hooks/lib/govdb/govdb-indexes.ts — read-path support for the board's
// incremental readers (DB-design point 3). Additive, self-healing on every
// open (the events-shred house pattern — IF NOT EXISTS, no user_version
// bump), so an older binary opening the same file is unaffected.
//
// - reader_cursors(name PK, event_id): a reader's persisted high-water mark
//   over the append-only events bus. A reader processes only id > event_id
//   and advances the mark in the same pass (events_since pattern).
// - events_source_ts: the ANSWERED → ACKNOWLEDGED transition probes "did the
//   answered lane emit anything since answered_at" per decision; with only
//   (kind, ts) available that was a kind-range walk per row (803ms on the
//   2026-10-29 snapshot, 172 ANSWERED rows); (source, ts) makes it a seek.
import type { Database } from "bun:sqlite";

export const READER_CURSORS_DDL =
	"CREATE TABLE IF NOT EXISTS reader_cursors (name TEXT PRIMARY KEY, event_id INTEGER NOT NULL, ts INTEGER NOT NULL)";

export function migrateReadIndexes(db: Database): void {
	db.run(READER_CURSORS_DDL);
	db.run("CREATE INDEX IF NOT EXISTS events_source_ts ON events(source, ts)");
}
