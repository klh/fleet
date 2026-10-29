// board/reader-cursor.ts — the events_since(cursor) pattern for the board's
// bus backfills (DB-design point 3). A reader persists the highest event id
// it has processed in reader_cursors (lib/govdb/govdb-indexes.ts) and the
// next pass reads only id > cursor — a rowid range instead of a full scan.
//
// Safety net: every SUSPENDERS_BOARD_FULL_RECONCILE_MS (default 300000; 0 =
// every pass is full) a pass ignores the cursor and rescans from 0, so a row
// whose qualifying state changed below the mark (a rekeyed project, a
// re-owned item) still converges — the scan bodies are idempotent INSERT OR
// IGNOREs, so a full pass only re-confirms what the incremental ones did.
// Fail-soft: a store without the table (older hub binary) reads cursor 0,
// i.e. exactly the old full-scan behaviour.

import { READER_CURSORS_DDL } from "../lib/govdb/govdb-indexes.ts";
import { boardKnob } from "./board-knobs.ts";
import { db } from "./context.ts";

let ensured = false;
// process start counts as a full pass: a restart resumes from the persisted
// cursor, and the first full rescan comes one window later
let lastFullAt = Date.now();

function ensure(): void {
	if (ensured) return;
	db.run(READER_CURSORS_DDL);
	ensured = true;
}

export function readCursor(name: string): number {
	try {
		ensure();
		const row = db
			.query("SELECT event_id FROM reader_cursors WHERE name = ?")
			.get(name) as { event_id: number } | null;
		return row?.event_id ?? 0;
	} catch {
		return 0;
	}
}

export function writeCursor(
	name: string,
	eventId: number,
	now = Date.now(),
): void {
	try {
		ensure();
		db.query(
			"INSERT INTO reader_cursors (name, event_id, ts) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET event_id = excluded.event_id, ts = excluded.ts",
		).run(name, eventId, now);
	} catch {} // fail-soft: the next pass rescans from the old mark
}

/** The cursor a pass should read above: 0 when the periodic full reconcile is
 * due (and that pass is then stamped as the last full one). */
export function cursorForPass(name: string, now = Date.now()): number {
	if (now - lastFullAt >= boardKnob("board.full_reconcile_ms")) {
		lastFullAt = now;
		return 0;
	}
	return readCursor(name);
}

/** Test seam: force the next cursorForPass to run full (or not). */
export function resetFullReconcile(at = Date.now()): void {
	lastFullAt = at;
}
