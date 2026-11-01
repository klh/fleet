// work-items.ts — W2327: fleet.work.v1.WorkItems List/Get over the SAME
// governor.db producers the CLIs read (work-report.ts's row shape, the
// events-shred columns). Keyset pagination on (updated_at, id) — never
// OFFSET; default order updated_at desc (the report's recency order).
// Filterable scalars map onto work_items columns; unknown field →
// invalid_argument naming it (fail loud, schema law).
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { type FieldMap, parseFilter, type SqlFragment } from "./filter.ts";
import { DataplaneProblem } from "./problems.ts";
import type { ListRequest, ListResponse } from "./schemas.ts";

/** Resource name grammar: projects/{project}/workItems/{id}. */
export const WORK_ITEM_NAME = /^projects\/([^/]+)\/workItems\/([^/]+)$/;

export interface WorkItemRow {
	name: string;
	id: string;
	project: string;
	title: string;
	description: string | null;
	state: string;
	priority: number;
	parent: string | null;
	ownerSid: string | null;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

const FIELDS: FieldMap = {
	state: { column: "state" },
	priority: { column: "priority", numeric: true },
	owner_sid: { column: "owner_sid" },
	parent: { column: "parent_id" },
	created_by: { column: "created_by" },
	created_at: { column: "created_at", numeric: true },
	updated_at: { column: "updated_at", numeric: true },
	title: { column: "title" },
	description: { column: "description" },
};

const row = (r: Record<string, unknown>): WorkItemRow => ({
	name: `projects/${encodeURIComponent(String(r.project))}/workItems/${String(r.id)}`,
	id: String(r.id),
	project: String(r.project),
	title: String(r.title ?? ""),
	description: r.description == null ? null : String(r.description),
	state: String(r.state ?? ""),
	priority: Number(r.priority ?? 0),
	parent: r.parent_id == null ? null : String(r.parent_id),
	ownerSid: r.owner_sid == null ? null : String(r.owner_sid),
	tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
	createdAt: new Date(Number(r.created_at)).toISOString(),
	updatedAt: new Date(Number(r.updated_at)).toISOString(),
});

type Sort = { col: string; dir: "asc" | "desc" };

/** order_by = "field [asc|desc]" over the mapped columns; default
 *  updated_at desc. Unknown field or direction → invalid_argument. */
const parseOrderBy = (raw: string | undefined): Sort => {
	if (!raw) return { col: "updated_at", dir: "desc" };
	const parts = raw.trim().split(/\s+/);
	const field = FIELDS[parts[0] as keyof FieldMap];
	if (!field)
		throw new DataplaneProblem(
			"invalid_argument",
			`unknown order_by field: ${parts[0]}`,
		);
	const dir = parts[1] ?? "desc";
	if (dir !== "asc" && dir !== "desc")
		throw new DataplaneProblem(
			"invalid_argument",
			`order_by direction must be asc|desc: ${parts[1]}`,
		);
	return { col: field.column, dir };
};

/** Keyset predicate: rows strictly AFTER the (value, id) cursor tuple in
 *  the active sort direction, NULL-aware — SQLite emits NULLs first in
 *  asc / last in desc, so a bare `col > ?` would strand or re-serve NULL
 *  rows on nullable columns (description, owner_sid, …). */
const keysetAfter = (
	col: string,
	dir: "asc" | "desc",
	value: string | number | null,
	id: string | number | null,
): { sql: string; params: unknown[] } => {
	const cmp = dir === "asc" ? ">" : "<";
	if (value === null) {
		// the cursor sat on a NULL row: asc → every non-NULL plus later
		// NULL ids; desc → only NULL ids past the cursor
		return dir === "asc"
			? {
					sql: `(${col} IS NOT NULL OR (${col} IS NULL AND id > ?))`,
					params: [id],
				}
			: { sql: `(${col} IS NULL AND id < ?)`, params: [id] };
	}
	// non-NULL cursor: strict compare + id tiebreak; desc additionally
	// keeps the NULL tail that sorts after every non-NULL value
	const tail = dir === "desc" ? `${col} IS NULL OR ` : "";
	return {
		sql: `(${tail}${col} ${cmp} ? OR (${col} = ? AND id ${cmp} ?))`,
		params: [value, value, id],
	};
};

/** WorkItems/List — keyset over the (sort, id) tuple. Terminal states are
 *  EXCLUDED by default (the report's "recent done" opt-in); filter on
 *  state = DONE etc. re-includes them (AIP-135 show_deleted posture). */
export function listWorkItems(
	db: GovernorStore,
	project: string,
	req: ListRequest,
): ListResponse<WorkItemRow> {
	const where: string[] = ["project = ?"];
	const params: unknown[] = [project];
	if (req.filter) {
		const frag = applyFilter(req.filter);
		where.push(frag.sql);
		params.push(...frag.params);
	}
	const sort = parseOrderBy(req.order_by);
	const cursor = req.page_token ? decodeCursor(req.page_token, 2) : null;
	if (req.page_token && !cursor)
		throw new DataplaneProblem("invalid_argument", "malformed page_token");
	if (cursor) {
		// keyset: strictly past the tuple in sort direction, id as tiebreak,
		// NULL-aware (SQLite emits NULLs first asc / last desc)
		const past = keysetAfter(sort.col, sort.dir, cursor[0], cursor[1]);
		where.push(past.sql);
		params.push(...past.params);
	}
	const pageSize = req.page_size ?? 50;
	const rows = db
		.query(
			`SELECT * FROM work_items WHERE ${where.join(" AND ")}
			 ORDER BY ${sort.col} ${sort.dir.toUpperCase()}, id ${sort.dir.toUpperCase()}
			 LIMIT ?`,
		)
		.all(...params, pageSize) as Record<string, unknown>[];
	const items = rows.map(row);
	const rawLast = rows.at(-1);
	return {
		items,
		next_page_token:
			rows.length === pageSize && rawLast
				? encodeCursor([cursorValueOf(rawLast, sort.col), String(rawLast.id)])
				: null,
	};
}

/** The raw SQL value of the active order_by column — the SAME value the
 *  ORDER BY sorted on (dates/priority as their stored numbers, string
 *  columns as their stored text), never a substituted epoch (B2 repair). */
const cursorValueOf = (
	r: Record<string, unknown>,
	col: string,
): string | number | null => {
	const v = r[col];
	if (v == null) return null;
	return typeof v === "number" ? v : String(v);
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

/** WorkItems/Get — by resource name; terminal items stay Get-able forever. */
export function getWorkItem(
	db: GovernorStore,
	project: string,
	id: string,
): WorkItemRow {
	const hit = db
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as Record<string, unknown> | null;
	if (!hit)
		throw new DataplaneProblem(
			"not_found",
			`projects/${project}/workItems/${id} not found`,
		);
	return row(hit);
}
