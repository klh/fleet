// lanes.ts — W2327: fleet.coord.v1.Lanes List/Get rendering from the SAME
// liveness producer `work lanes` reads (lane-registry + lane-liveness) —
// never a second liveness derivation. Fleet-wide collection (no project
// parent); sid-keyed Get. Filtering is in-memory post-projection (the
// registry is a JSON file, not SQL) — the AIP-160 scalar subset over the
// projected fields.
import { laneAlive } from "../lanes/lane-liveness.ts";
import { loadLaneRegistry, type RegistryLane } from "../lanes/lane-registry.ts";
import { DataplaneProblem } from "./problems.ts";
import type { ListRequest, ListResponse } from "./schemas.ts";

export interface LaneRow {
	name: string;
	sid: string;
	item: string | null;
	state: "alive" | "dead";
	host: string | null;
	worktree: string | null;
	pid: number | null;
	launchedAt: string | null;
}

export const LANE_NAME = /^lanes\/([^/]+)$/;

const row = (l: RegistryLane & { host?: string }): LaneRow => ({
	name: `lanes/${l.sid}`,
	sid: l.sid,
	item: l.item ?? null,
	state: laneAlive(l as Parameters<typeof laneAlive>[0]) ? "alive" : "dead",
	host: l.host ?? null,
	worktree: l.worktree ?? null,
	pid: l.pid ?? null,
	launchedAt:
		typeof l.launchedAt === "number" && l.launchedAt > 0
			? new Date(l.launchedAt).toISOString()
			: null,
});

/** The registry rows as the dataplane sees them — one projection face. */
export const laneRows = (fleetRoot: string): LaneRow[] =>
	loadLaneRegistry<RegistryLane & { host?: string }>(fleetRoot).map(row);

/** Scalar-contains match on projected fields (subset AIP-160: `field :
 *  value` semantics via simple equality/contains over string fields). */
const matches = (l: LaneRow, filter: string): boolean => {
	const m = /^(\w+)\s*(:|!=|=)\s*(.+)$/.exec(filter.trim());
	if (!m)
		throw new DataplaneProblem(
			"invalid_argument",
			`lanes filter must be 'field op value': ${filter}`,
		);
	const [, field, op, rawValue] = m;
	const value = rawValue.replace(/^"|"$/g, "");
	const known: Record<string, unknown> = {
		sid: l.sid,
		item: l.item,
		state: l.state,
		host: l.host,
		worktree: l.worktree,
	};
	if (!(field in known))
		throw new DataplaneProblem(
			"invalid_argument",
			`unknown filter field: ${field}`,
		);
	const actual = known[field];
	if (op === ":") return String(actual ?? "").includes(value);
	return String(actual ?? "") === value;
};

/** Lanes/List — liveness-audited registry rows, filtered in memory. */
export function listLanes(
	fleetRoot: string,
	req: ListRequest,
): ListResponse<LaneRow> {
	let rows = laneRows(fleetRoot);
	if (req.filter) {
		// the parser contract is SQL-shaped; lanes are not SQL — accept the
		// single-clause subset, refuse AND/OR (invalid_argument, fail loud)
		if (/\b(AND|OR|NOT)\b/i.test(req.filter))
			throw new DataplaneProblem(
				"invalid_argument",
				"lanes filter supports one clause only (no AND/OR/NOT)",
			);
		rows = rows.filter((l) => matches(l, req.filter as string));
	}
	// newest launch first; sid tiebreak (stable, deterministic)
	rows.sort((a, b) => (b.launchedAt ?? "").localeCompare(a.launchedAt ?? ""));
	const pageSize = req.page_size ?? 50;
	const page = rows.slice(0, pageSize);
	return {
		items: page,
		next_page_token: rows.length > pageSize ? String(pageSize) : null,
	};
}

/** Lanes/Get — by sid; every registry lane stays Get-able. */
export function getLane(fleetRoot: string, sid: string): LaneRow {
	const hit = laneRows(fleetRoot).find((l) => l.sid === sid);
	if (!hit) throw new DataplaneProblem("not_found", `lanes/${sid} not found`);
	return hit;
}
