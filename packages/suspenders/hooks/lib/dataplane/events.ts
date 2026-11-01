// events.ts — W2327: fleet.coord.v1.Events List — the append-only audit
// trail over the W603 shred columns (events.project / events.work), keyset
// on events.id DESC (the events_work_id / events_project_ts indexes).
// List only per the design (append-only log); filter on kind/work/source.
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { parseFilter, type FieldMap, type SqlFragment } from "./filter.ts";
import { DataplaneProblem } from "./problems.ts";
import type { ListRequest, ListResponse } from "./schemas.ts";

export const EVENT_NAME = /^projects\/([^/]+)\/events\/(\d+)$/;

export interface EventRow {
	name: string;
	eventId: number;
	kind: string;
	source: string;
	scope: string | null;
	target: string | null;
	work: string | null;
	payload: unknown;
	ts: string;
}

const FIELDS: FieldMap = {
	kind: { column: "kind" },
	source: { column: "source" },
	scope: { column: "scope" },
	work: { column: "work" },
	target: { column: "target" },
};

const row = (r: Record<string, unknown>): EventRow => {
	const project = String(r.project ?? "");
	const id = Number(r.id);
	return {
		name: `projects/${project}/events/${id}`,
		eventId: id,
		kind: String(r.kind ?? ""),
		source: String(r.source ?? ""),
		scope: r.scope == null ? null : String(r.scope),
		target: r.target == null ? null : String(r.target),
		work: r.work == null ? null : String(r.work),
		payload: safeJson(r.payload),
		ts: new Date(Number(r.ts)).toISOString(),
	};
};

const safeJson = (raw: unknown): unknown => {
	if (raw == null) return null;
	try {
		return JSON.parse(String(raw));
	} catch {
		return String(raw);
	}
};

function applyFilter(filter: string): SqlFragment {
	try {
		return parseFilter(filter, FIELDS);
	} catch (e) {
		const field =
			e instanceof Error && "field" in e ? String(e.field) : "unknown";
		throw new DataplaneProblem(
			"invalid_argument",
			`invalid filter near field '${field}': ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** Events/List — newest first (id DESC), keyset on id, project-scoped. */
export function listEvents(
	db: GovernorStore,
	project: string,
	req: ListRequest,
): ListResponse<EventRow> {
	const where: string[] = ["project = ?"];
	const params: unknown[] = [project];
	if (req.filter) {
		const frag = applyFilter(req.filter);
		where.push(frag.sql);
		params.push(...frag.params);
	}
	if (req.order_by && req.order_by.trim() !== "id desc")
		throw new DataplaneProblem(
			"invalid_argument",
			`events order_by supports 'id desc' only: ${req.order_by}`,
		);
	const cursor = req.page_token ? decodeCursor(req.page_token, 1) : null;
	if (req.page_token && !cursor)
		throw new DataplaneProblem("invalid_argument", "malformed page_token");
	if (cursor) {
		where.push("id < ?");
		params.push(cursor[0]);
	}
	const pageSize = req.page_size ?? 50;
	const rows = db
		.query(
			`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
		)
		.all(...params, pageSize) as Record<string, unknown>[];
	const items = rows.map(row);
	return {
		items,
		next_page_token:
			rows.length === pageSize && items.at(-1)
				? encodeCursor([items.at(-1).eventId])
				: null,
	};
}
