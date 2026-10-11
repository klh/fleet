// hooks/coord/event-scan.ts — W644: keyset-paged bus scans. `WHERE id > ?
// ORDER BY id LIMIT ?` rides the events rowid index, so a poll pays for its
// pages, not the whole tail; scope/kinds filter per row, and the returned
// `examined` advances only across rows the filters actually saw — a rejected
// row can never match again (the filter set is fixed per call), while rows
// beyond the last examined row stay behind the cursor.
import { db, scopeCovers, type Ev } from "./shared.ts";

export const POLL_PAGE = 500;

export const fetchEventsPaged = (o: {
	since: number;
	as?: string | null;
	scope?: string | null;
	kinds?: string[];
	/** Stop after this many matches; undefined scans to the bus head. */
	limit?: number;
}): { shown: Ev[]; examined: number } => {
	const shown: Ev[] = [];
	let examined = o.since;
	const stmt = db.query(
		o.as
			? "SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id LIMIT ?"
			: "SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND target IS NULL ORDER BY id LIMIT ?",
	);
	for (;;) {
		const page = (
			o.as ? stmt.all(examined, o.as, POLL_PAGE) : stmt.all(examined, POLL_PAGE)
		) as Ev[];
		if (!page.length) break;
		for (const r of page) {
			examined = r.id;
			if (
				o.scope &&
				!(
					r.scope &&
					(r.scope === o.scope ||
						scopeCovers(r.scope, o.scope) ||
						scopeCovers(o.scope, r.scope))
				)
			)
				continue;
			if (o.kinds?.length && !o.kinds.includes(r.kind)) continue;
			shown.push(r);
			// limit<=0 = unbounded; the >0 check also keeps a degenerate limit
			// from advancing the cursor one row per call
			if (o.limit !== undefined && o.limit > 0 && shown.length >= o.limit)
				return { shown, examined };
		}
		if (page.length < POLL_PAGE) break;
	}
	return { shown, examined };
};

/** Upsert the per-sid cursor forward, never back. Callers pass the last row
 *  they EXAMINED — shown or filtered — so a dormant consumer pays one page
 *  per poll instead of re-scanning the whole bus tail forever. */
export const advanceCursor = (sid: string, from: number, to: number): void => {
	if (to <= from) return;
	if (db.query("SELECT 1 FROM cursors WHERE sid = ?").get(sid))
		db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(to, sid);
	else
		db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(sid, to);
};
