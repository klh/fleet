// hooks/lib/events-shred.ts — W603 (DuckDB-2.0 model-what-you-know): the
// event bus's hot filter fields — payload $.project and $.work — shredded
// into real indexed columns. The board polls per-second and projectIdentity/
// workTiming/tokenUsage replay filtered on json_extract(payload, ...) per
// row; after v14 those predicates hit columns + indexes, never the payload.
// govdb v14: ADD COLUMN project/work + one-time backfill; an AFTER INSERT
// trigger stamps new rows so all 45+ emit sites stay untouched (one source
// of truth — the payload remains the reader surface, columns are the index).
import type { Database } from "bun:sqlite";

// runs EVERY open (idempotent): column adds + trigger + indexes self-heal,
// the backfill + version bump ride the uv<14 guard exactly once
export function migrateEventsShred(db: Database): void {
	const cols = (
		db.query("PRAGMA table_info(events)").all() as { name: string }[]
	).map((c) => c.name);
	if (!cols.includes("project"))
		db.run("ALTER TABLE events ADD COLUMN project TEXT");
	if (!cols.includes("work")) db.run("ALTER TABLE events ADD COLUMN work TEXT");
	// stamp-on-insert keeps the columns true without touching any emitter:
	// work.claimed carries $.project+$.work, BROADCASTs carry $.project or
	// nothing (NULL = the pre-shred shape, same as json_extract's NULL).
	db.run(
		"CREATE TRIGGER IF NOT EXISTS events_shred_ai AFTER INSERT ON events BEGIN UPDATE events SET project = json_extract(NEW.payload, '$.project'), work = json_extract(NEW.payload, '$.work') WHERE id = NEW.id; END",
	);
	// (project, ts) serves the projectIdentity/timing replays (kind-filtered,
	// ts-ordered) and the coord fleet friction counts; (work, id) serves the
	// item-tail reads (board drawer, failNote, monitor's NOT EXISTS dedupe).
	db.run("CREATE INDEX IF NOT EXISTS events_project_ts ON events(project, ts)");
	db.run("CREATE INDEX IF NOT EXISTS events_work_id ON events(work, id)");
	const uv = (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
	if (uv < 14) {
		db.run(
			"UPDATE events SET project = json_extract(payload, '$.project'), work = json_extract(payload, '$.work')",
		);
		db.run("PRAGMA user_version = 14");
	}
}
