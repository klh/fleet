// lane-read-model.ts — W461.3 observability stage 3: the lane/route read
// model (docs/upstream-observability-architecture.md §3). Three projected
// tables — lane descriptors, per-observer lane presence, request edges —
// plus scoped grouped queries: immediate-downstream grouping default,
// origin/project/time/outcome filters, distinct-lane counts (origin and
// peer groups overlap, so group counts are NOT additive), and keyset-
// paginated detail. Presence projects from the authenticated operator
// observations (board_lane_observations) so the model is alive before
// stage-2 ingest lands; edges ingest is idempotent (CloudEvents-style
// equal source + event id = duplicate, ignored).
// A visibility edge proves only that a hub observed a lane through a peer
// during an interval — never work authority or lifecycle end.
import type { GovernorStore } from "../lib/govdb.ts";
import {
	laneObservationSnapshot,
	type LaneObservation,
} from "./lane-observations.ts";

export const EDGE_ROW_CAP = 10_000;
export const DESCRIPTOR_ROW_CAP = 5_000;
export const INGEST_BATCH_CAP = 200;

export interface RequestEdgeEvent {
	source: string;
	eventId: string;
	observerHub: string;
	originHub: string;
	peerHub: string;
	laneId: string;
	project: string;
	requestId: string;
	outcome: "ok" | "error";
	ts: number;
	traceId?: string;
	dispatchAttempt?: string;
}

export function ensureLaneReadModel(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS board_lane_descriptors (
		lane_id TEXT NOT NULL, project TEXT NOT NULL, origin_hub TEXT NOT NULL,
		first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
		dispatch_attempt TEXT, PRIMARY KEY (lane_id, project, origin_hub))`);
	db.run(`CREATE TABLE IF NOT EXISTS board_observer_presence (
		observer_hub TEXT NOT NULL, lane_id TEXT NOT NULL, project TEXT NOT NULL,
		peer_hub TEXT NOT NULL, origin_hub TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
		PRIMARY KEY (observer_hub, lane_id, project, peer_hub))`);
	db.run(`CREATE TABLE IF NOT EXISTS board_request_edges (
		id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL,
		observer_hub TEXT NOT NULL, origin_hub TEXT NOT NULL, peer_hub TEXT NOT NULL,
		lane_id TEXT NOT NULL, project TEXT NOT NULL, request_id TEXT NOT NULL,
		outcome TEXT NOT NULL, ts INTEGER NOT NULL, trace_id TEXT,
		UNIQUE (source, event_id))`);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_request_edges_peer_ts ON board_request_edges (peer_hub, ts)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_request_edges_project_ts ON board_request_edges (project, ts)",
	);
}

function identity(value: unknown, max = 128): value is string {
	return (
		typeof value === "string" &&
		!!value.trim() &&
		value.length <= max &&
		![...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

function optionalIdentity(value: unknown): value is string | undefined {
	return (
		value === undefined ||
		(identity(value) && !["all", "unknown"].includes(value))
	);
}

/** Validates one edge event; returns the error string or null when valid. */
function edgeEventError(
	e: Record<string, unknown>,
	now: number,
): string | null {
	for (const [key, value, max] of [
		["source", e.source, 128],
		["eventId", e.eventId, 256],
		["observerHub", e.observerHub, 128],
		["originHub", e.originHub, 128],
		["peerHub", e.peerHub, 128],
		["laneId", e.laneId, 128],
		["project", e.project, 1024],
		["requestId", e.requestId, 256],
	] as const) {
		const reserved =
			key.endsWith("Hub") && ["all", "unknown"].includes(String(value));
		if (!identity(value, max) || reserved) return `Invalid ${key}`;
	}
	if (e.outcome !== "ok" && e.outcome !== "error") return "Invalid outcome";
	if (
		typeof e.ts !== "number" ||
		!Number.isSafeInteger(e.ts) ||
		e.ts > now + 5_000 ||
		e.ts < now - 86_400_000
	)
		return "Invalid ts";
	if (!optionalIdentity(e.traceId) || !optionalIdentity(e.dispatchAttempt))
		return "Invalid traceId or dispatchAttempt";
	return null;
}

/** Bounded idempotent ingest of request-edge observations. */
export function ingestRequestEdges(
	db: GovernorStore,
	events: unknown,
	now = Date.now(),
): { ok: boolean; error?: string; accepted: number; duplicates: number } {
	if (!Array.isArray(events) || events.length > INGEST_BATCH_CAP)
		return {
			ok: false,
			error: `Expected an array of at most ${INGEST_BATCH_CAP} events`,
			accepted: 0,
			duplicates: 0,
		};
	const valid: RequestEdgeEvent[] = [];
	for (const raw of events) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			return {
				ok: false,
				error: "Expected an event object",
				accepted: 0,
				duplicates: 0,
			};
		const e = raw as Record<string, unknown>;
		const error = edgeEventError(e, now);
		if (error) return { ok: false, error, accepted: 0, duplicates: 0 };
		valid.push({
			source: e.source as string,
			eventId: e.eventId as string,
			observerHub: e.observerHub as string,
			originHub: e.originHub as string,
			peerHub: e.peerHub as string,
			laneId: e.laneId as string,
			project: e.project as string,
			requestId: e.requestId as string,
			outcome: e.outcome as "ok" | "error",
			ts: e.ts as number,
			...(typeof e.traceId === "string" ? { traceId: e.traceId } : {}),
			...(typeof e.dispatchAttempt === "string"
				? { dispatchAttempt: e.dispatchAttempt }
				: {}),
		});
	}
	let accepted = 0;
	let duplicates = 0;
	db.transaction(() => {
		for (const e of valid) {
			const insert = db.run(
				`INSERT OR IGNORE INTO board_request_edges
				(source, event_id, observer_hub, origin_hub, peer_hub, lane_id, project, request_id, outcome, ts, trace_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				e.source,
				e.eventId,
				e.observerHub,
				e.originHub,
				e.peerHub,
				e.laneId,
				e.project,
				e.requestId,
				e.outcome,
				e.ts,
				e.traceId ?? null,
			);
			if (insert.changes > 0) {
				accepted++;
				db.run(
					`INSERT INTO board_lane_descriptors
					(lane_id, project, origin_hub, first_seen_at, last_seen_at, dispatch_attempt)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(lane_id, project, origin_hub) DO UPDATE SET
					first_seen_at = MIN(board_lane_descriptors.first_seen_at, excluded.first_seen_at),
					last_seen_at = MAX(board_lane_descriptors.last_seen_at, excluded.last_seen_at),
					dispatch_attempt = excluded.dispatch_attempt`,
					e.laneId,
					e.project,
					e.originHub,
					e.ts,
					e.ts,
					e.dispatchAttempt ?? null,
				);
			} else duplicates++;
		}
		db.run(
			`DELETE FROM board_request_edges WHERE id NOT IN
			(SELECT id FROM board_request_edges ORDER BY id DESC LIMIT ?)`,
			EDGE_ROW_CAP,
		);
		db.run(
			`DELETE FROM board_lane_descriptors WHERE rowid NOT IN
			(SELECT rowid FROM board_lane_descriptors ORDER BY last_seen_at DESC LIMIT ?)`,
			DESCRIPTOR_ROW_CAP,
		);
	})();
	return { ok: true, accepted, duplicates };
}

/** Projects presence: expires stale rows, folds in current evidence. */
export function projectPresence(
	db: GovernorStore,
	now = Date.now(),
	presence?: LaneObservation[],
): number {
	const rows =
		presence ??
		laneObservationSnapshot(db, null, now).lanes.filter(
			(lane) => lane.expiresAt > now,
		);
	let upserted = 0;
	db.transaction(() => {
		db.run("DELETE FROM board_observer_presence WHERE expires_at <= ?", now);
		// presence is a projection of CURRENT evidence: a row whose source
		// observation vanished (expired, replaced) must not survive here —
		// stale evidence is unknown, never a live lane
		db.run(
			"CREATE TEMP TABLE IF NOT EXISTS presence_keys (observer_hub TEXT, lane_id TEXT, project TEXT, peer_hub TEXT)",
		);
		db.run("DELETE FROM presence_keys");
		for (const lane of rows) {
			if (!identity(lane.originHub) || !identity(lane.peerHub)) continue;
			db.run(
				`INSERT INTO board_observer_presence
				(observer_hub, lane_id, project, peer_hub, origin_hub, first_seen_at, last_seen_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(observer_hub, lane_id, project, peer_hub) DO UPDATE SET
				first_seen_at = MIN(board_observer_presence.first_seen_at, excluded.first_seen_at),
				last_seen_at = MAX(board_observer_presence.last_seen_at, excluded.last_seen_at),
				expires_at = excluded.expires_at`,
				lane.peerHub,
				lane.laneId,
				lane.project,
				lane.peerHub,
				lane.originHub,
				lane.observedAt,
				lane.observedAt,
				lane.expiresAt,
			);
			db.run(
				"INSERT INTO presence_keys (observer_hub, lane_id, project, peer_hub) VALUES (?, ?, ?, ?)",
				lane.peerHub,
				lane.laneId,
				lane.project,
				lane.peerHub,
			);
			upserted++;
			db.run(
				`INSERT INTO board_lane_descriptors
				(lane_id, project, origin_hub, first_seen_at, last_seen_at, dispatch_attempt)
				VALUES (?, ?, ?, ?, ?, NULL)
				ON CONFLICT(lane_id, project, origin_hub) DO UPDATE SET
				first_seen_at = MIN(board_lane_descriptors.first_seen_at, excluded.first_seen_at),
				last_seen_at = MAX(board_lane_descriptors.last_seen_at, excluded.last_seen_at)`,
				lane.laneId,
				lane.project,
				lane.originHub,
				lane.observedAt,
				lane.observedAt,
			);
		}
		db.run(
			`DELETE FROM board_observer_presence WHERE NOT EXISTS (
			SELECT 1 FROM presence_keys k
			WHERE k.observer_hub = board_observer_presence.observer_hub
			AND k.lane_id = board_observer_presence.lane_id
			AND k.project = board_observer_presence.project
			AND k.peer_hub = board_observer_presence.peer_hub)`,
		);
		db.run("DELETE FROM presence_keys");
	})();
	return upserted;
}

export interface LaneModelFilters {
	project: string | null;
	origin: string | null;
	peer: string | null;
	since: number;
	until: number;
	outcome: "ok" | "error" | null;
	group: "peer" | "origin";
}

export function parseLaneModelFilters(
	url: URL,
	now = Date.now(),
): LaneModelFilters | string {
	const get = (key: string) => {
		const value = url.searchParams.get(key);
		return value && value !== "all" ? value : null;
	};
	const since = Number(url.searchParams.get("since")) || 0;
	const until = Number(url.searchParams.get("until")) || now;
	const outcome = url.searchParams.get("outcome");
	const group = url.searchParams.get("group");
	if (since < 0 || until < since) return "Invalid time window";
	if (outcome && outcome !== "ok" && outcome !== "error")
		return "Invalid outcome filter";
	if (group && group !== "peer" && group !== "origin")
		return "Invalid group (peer | origin)";
	return {
		project: get("project"),
		origin: get("origin"),
		peer: get("peer"),
		since,
		until,
		outcome: (outcome as "ok" | "error" | null) ?? null,
		group: (group as "peer" | "origin") ?? "peer",
	};
}

function edgeWhere(filters: LaneModelFilters): {
	sql: string;
	params: unknown[];
} {
	const clauses = ["ts >= ?", "ts <= ?"];
	const params: unknown[] = [filters.since, filters.until];
	if (filters.project) {
		clauses.push("project = ?");
		params.push(filters.project);
	}
	if (filters.origin) {
		clauses.push("origin_hub = ?");
		params.push(filters.origin);
	}
	if (filters.peer) {
		clauses.push("peer_hub = ?");
		params.push(filters.peer);
	}
	if (filters.outcome) {
		clauses.push("outcome = ?");
		params.push(filters.outcome);
	}
	return { sql: clauses.join(" AND "), params };
}

export interface LaneModelGroup {
	hub: string;
	distinctLanes: number;
	requests: number;
	errors: number;
	lastSeenAt: number | null;
}

export interface LaneModelGroups {
	ts: number;
	groupBy: "peer" | "origin";
	groups: LaneModelGroup[];
	totals: { distinctLanes: number; requests: number; errors: number };
	/** Group counts overlap by construction (doc §3) — never sum them. */
	additive: false;
}

export function laneModelGroups(
	db: GovernorStore,
	filters: LaneModelFilters,
	now = Date.now(),
): LaneModelGroups {
	projectPresence(db, now);
	const axis = filters.group;
	const axisColumn = axis === "peer" ? "peer_hub" : "origin_hub";
	const where = edgeWhere(filters);
	const groups = new Map<string, LaneModelGroup>();
	const edges = db
		.query(
			`SELECT ${axisColumn} AS hub, COUNT(DISTINCT lane_id) AS lanes, COUNT(*) AS requests,
			SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS errors, MAX(ts) AS lastSeen
			FROM board_request_edges WHERE ${where.sql} GROUP BY ${axisColumn}`,
		)
		.all(...where.params) as {
		hub: string;
		lanes: number;
		requests: number;
		errors: number;
		lastSeen: number;
	}[];
	for (const row of edges)
		groups.set(row.hub, {
			hub: row.hub,
			distinctLanes: row.lanes,
			requests: row.requests,
			errors: row.errors ?? 0,
			lastSeenAt: row.lastSeen,
		});
	const presenceClauses = ["last_seen_at >= ?", "first_seen_at <= ?"];
	const presenceParams: unknown[] = [filters.since, filters.until];
	if (filters.project) {
		presenceClauses.push("project = ?");
		presenceParams.push(filters.project);
	}
	if (filters.origin) {
		presenceClauses.push("origin_hub = ?");
		presenceParams.push(filters.origin);
	}
	if (filters.peer) {
		presenceClauses.push("peer_hub = ?");
		presenceParams.push(filters.peer);
	}
	const presence = db
		.query(
			`SELECT ${axisColumn} AS hub, COUNT(DISTINCT lane_id) AS lanes, MAX(last_seen_at) AS lastSeen
			FROM board_observer_presence WHERE ${presenceClauses.join(" AND ")} GROUP BY ${axisColumn}`,
		)
		.all(...presenceParams) as {
		hub: string;
		lanes: number;
		lastSeen: number;
	}[];
	for (const row of presence) {
		const existing = groups.get(row.hub);
		if (existing) {
			// a hub with edge traffic also has live presence — lanes already counted
			existing.lastSeenAt = Math.max(existing.lastSeenAt ?? 0, row.lastSeen);
			continue;
		}
		groups.set(row.hub, {
			hub: row.hub,
			distinctLanes: row.lanes,
			requests: 0,
			errors: 0,
			lastSeenAt: row.lastSeen,
		});
	}
	const totals = { distinctLanes: 0, requests: 0, errors: 0 };
	const laneScope = (sql: string, params: unknown[]) =>
		(db.query(sql).get(...params) as { n: number } | null)?.n ?? 0;
	totals.distinctLanes =
		laneScope(
			`SELECT COUNT(DISTINCT lane_id) AS n FROM board_request_edges WHERE ${where.sql}`,
			where.params,
		) +
		laneScope(
			`SELECT COUNT(DISTINCT lane_id) AS n FROM board_observer_presence
			WHERE ${presenceClauses.join(" AND ")}
			AND lane_id NOT IN (SELECT DISTINCT lane_id FROM board_request_edges WHERE ${where.sql})`,
			[...presenceParams, ...where.params],
		);
	for (const group of groups.values()) {
		totals.requests += group.requests;
		totals.errors += group.errors;
	}
	return {
		ts: now,
		groupBy: axis,
		groups: [...groups.values()].sort(
			(a, b) =>
				(b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.hub.localeCompare(b.hub),
		),
		totals,
		additive: false,
	};
}

const EDGE_COLUMNS = `id, source, event_id AS eventId, observer_hub AS observerHub,
	origin_hub AS originHub, peer_hub AS peerHub, lane_id AS laneId, project,
	request_id AS requestId, outcome, ts, trace_id AS traceId`;

/** Keyset-paginated edge detail; cursor = the last row's id (id < cursor). */
export function laneModelDetail(
	db: GovernorStore,
	filters: LaneModelFilters,
	cursor: number | null,
	limit: number,
): { rows: Record<string, unknown>[]; nextCursor: number | null } {
	const where = edgeWhere(filters);
	const capped = Math.min(Math.max(limit, 1), 200);
	const clauses = [where.sql];
	if (cursor) clauses.push("id < ?");
	const rows = db
		.query(
			`SELECT ${EDGE_COLUMNS}
			FROM board_request_edges WHERE ${clauses.join(" AND ")}
			ORDER BY id DESC LIMIT ?`,
		)
		.all(...where.params, ...(cursor ? [cursor] : []), capped + 1) as Record<
		string,
		unknown
	>[];
	const page = rows.slice(0, capped);
	return {
		rows: page,
		nextCursor: rows.length > capped ? (page.at(-1)?.id as number) : null,
	};
}

/** New edges past a cursor for the bounded push stream (server-filtered).
 * Overflow (more than the ring can hold in one tick) signals resync: the
 * client re-fetches the snapshot instead of trusting a partial replay. */
export function laneModelDelta(
	db: GovernorStore,
	filters: LaneModelFilters,
	cursor: number,
): { rows: Record<string, unknown>[]; cursor: number; overflow: boolean } {
	const where = edgeWhere(filters);
	const rows = db
		.query(
			`SELECT ${EDGE_COLUMNS} FROM board_request_edges
			WHERE id > ? AND ${where.sql} ORDER BY id LIMIT 65`,
		)
		.all(cursor, ...where.params) as Record<string, unknown>[];
	if (!rows.length) return { rows: [], cursor, overflow: false };
	const nextCursor = (rows.at(-1)?.id as number) ?? cursor;
	if (rows.length > 64) return { rows: [], cursor: nextCursor, overflow: true };
	return { rows, cursor: nextCursor, overflow: false };
}
