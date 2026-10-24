// hooks/board/events.ts — event feeds: drawer per-item events, item
// decisions, the bus activity feed, the /api/data events strip.
// W1255.4: moved verbatim from board/data.ts (per-domain split, THEN.B).
import { db, type EventRow } from "./context.ts";
import { ago, payloadOf, projOf } from "./lanes.ts";

// the drawer's event feed: last 50 events tied to the item — payload.work
// match (project-stamped) or scope match, newest first
export function workEvents(p: string, id: string): unknown[] {
	return (
		db
			.query(
				`SELECT id, ts, source, kind, payload FROM events
				WHERE (work = ? AND project = ?)
					OR (scope = ? AND project = ?)
				ORDER BY id DESC LIMIT 50`,
			)
			.all(id, p, id, p) as EventRow[]
	).map((e) => {
		const pl = payloadOf(e.payload);
		return {
			id: e.id,
			ts: e.ts,
			kind: e.kind,
			source: e.source,
			note: pl.note != null ? String(pl.note) : null,
			sha: pl.sha != null ? String(pl.sha) : null,
		};
	});
}

// newest-first bus feed. note/sha ride the payload; project too (CLI emitters
// stamp it — the source session's project covers anything older). Keyset
// pagination (W451): `before` is the previous page's last id — the caller
// drains history with ?before=<nextCursor>; a partial page means the end.
export function activity(
	p: string | null,
	limit: number,
	before?: number,
): { events: unknown[]; nextCursor: number | null } {
	const hasCursor = typeof before === "number" && Number.isFinite(before);
	const cursorSql = hasCursor ? " AND id < ?" : "";
	const evs = (
		p && p !== "all"
			? db
					.query(
						`SELECT id, ts, source, kind, payload, target FROM events
					WHERE (project = ?
						OR (project IS NULL AND source IN (SELECT sid FROM sessions WHERE project = ?)))${cursorSql}
					ORDER BY id DESC LIMIT ?`,
					)
					.all(...(hasCursor ? [p, p, before, limit] : [p, p, limit]))
			: db
					.query(
						`SELECT id, ts, source, kind, payload, target FROM events WHERE 1=1${cursorSql} ORDER BY id DESC LIMIT ?`,
					)
					.all(...(hasCursor ? [before, limit] : [limit]))
	) as EventRow[];
	const rows = evs.map((e) => {
		const pl = payloadOf(e.payload);
		return {
			id: e.id,
			ts: e.ts,
			kind: e.kind,
			source: e.source,
			target: e.target ?? null,
			note: pl.note != null ? String(pl.note) : null,
			sha: pl.sha != null ? String(pl.sha) : null,
			project: pl.project ?? projOf(e.source) ?? null,
		};
	});
	return {
		events: rows,
		nextCursor: evs.length === limit ? (evs[evs.length - 1]?.id ?? null) : null,
	};
}

export function events(): unknown[] {
	return (
		db
			.query(
				"SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50",
			)
			.all() as EventRow[]
	).map((e) => {
		let note = "";
		try {
			note = e.payload
				? Object.entries(JSON.parse(e.payload))
						.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
						.join(" ")
				: "";
		} catch {
			note = "(malformed)";
		}
		return {
			id: e.id,
			tsAgo: ago(e.ts),
			source: e.source,
			kind: e.kind,
			scope: e.scope,
			target: e.target,
			note,
		};
	});
}
