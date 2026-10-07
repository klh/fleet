import { expect, test } from "bun:test";

const NOW = Date.now();
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import { ensureLaneObservations } from "../hooks/board/lane-observations.ts";
import {
	EDGE_ROW_CAP,
	type LaneModelFilters,
	ensureLaneReadModel,
	ingestRequestEdges,
	laneModelDelta,
	laneModelDetail,
	laneModelGroups,
	parseLaneModelFilters,
	projectPresence,
} from "../hooks/board/lane-read-model.ts";

function store(): GovernorStore {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.transaction = ((fn: () => unknown) => () => fn()) as never;
	ensureLaneReadModel(db);
	ensureLaneObservations(db);
	return db;
}

const filters = (over: Partial<LaneModelFilters> = {}): LaneModelFilters => ({
	project: null,
	origin: null,
	peer: null,
	since: 0,
	until: Number.MAX_SAFE_INTEGER,
	outcome: null,
	group: "peer",
	...over,
});

// ts = NOW - ageMs: every timestamp is recent, inside ingest validation.
const edge = (over: Record<string, unknown> = {}, ageMs = 5_000) => ({
	source: "hub-a/outbox",
	eventId: `evt-${Math.random()}`,
	observerHub: "hub-a",
	originHub: "hub-origin",
	peerHub: "hub-a",
	laneId: "lane-1",
	project: "/p/repo/.git",
	requestId: "req-1",
	outcome: "ok",
	ts: NOW - ageMs,
	...over,
});

test("edge ingest is idempotent on equal source + event id and projects descriptors", () => {
	const db = store();
	const first = ingestRequestEdges(db, [edge({ eventId: "e1" })]);
	expect(first).toEqual({ ok: true, accepted: 1, duplicates: 0 });
	const replay = ingestRequestEdges(db, [edge({ eventId: "e1" })]);
	expect(replay.accepted).toBe(0);
	expect(replay.duplicates).toBe(1);
	const descriptor = db
		.query("SELECT * FROM board_lane_descriptors")
		.get() as Record<string, number | string>;
	expect(descriptor.first_seen_at).toBe(NOW - 5_000);
	expect(descriptor.last_seen_at).toBe(NOW - 5_000);
	const later = ingestRequestEdges(db, [edge({ eventId: "e2" }, 1_000)]);
	expect(later.accepted).toBe(1);
	const grown = db
		.query("SELECT first_seen_at, last_seen_at FROM board_lane_descriptors")
		.get() as Record<string, number>;
	expect(grown.first_seen_at).toBe(NOW - 5_000);
	expect(grown.last_seen_at).toBe(NOW - 1_000);
});

test("ingest validates provenance and bounds the batch", () => {
	const db = store();
	const bad = ingestRequestEdges(db, [edge({ peerHub: "unknown" })]);
	expect(bad.ok).toBe(false);
	expect(bad.error).toContain("peerHub");
	const stale = ingestRequestEdges(db, [edge({}, 86_400_001)]);
	expect(stale.ok).toBe(false);
	expect(stale.error).toContain("ts");
	const oversized = ingestRequestEdges(
		db,
		Array.from({ length: 201 }, () => edge()),
	);
	expect(oversized.ok).toBe(false);
	expect(oversized.error).toContain("at most");
	// an over-cap batch is refused whole — nothing partially lands
	const refused = ingestRequestEdges(db, Array.from({ length: 201 }, () => edge()));
	expect(refused.ok).toBe(false);
	expect(refused.accepted).toBe(0);
	const capped = ingestRequestEdges(db, Array.from({ length: 200 }, () => edge()));
	expect(capped.ok).toBe(true);
	expect(capped.accepted).toBe(200);
});

test("groups default to immediate downstream with non-additive distinct-lane totals", () => {
	const db = store();
	ingestRequestEdges(db, [
		edge({ eventId: "a", peerHub: "hub-a", originHub: "hub-o", laneId: "l1" }),
		edge({ eventId: "b", peerHub: "hub-a", originHub: "hub-o", laneId: "l2" }),
		edge({ eventId: "c", peerHub: "hub-b", originHub: "hub-o", laneId: "l1" }),
	]);
	const result = laneModelGroups(db, filters());
	expect(result.groupBy).toBe("peer");
	expect(result.additive).toBe(false);
	const byHub = new Map(result.groups.map((g) => [g.hub, g]));
	expect(byHub.get("hub-a")?.distinctLanes).toBe(2);
	expect(byHub.get("hub-a")?.requests).toBe(2);
	expect(byHub.get("hub-b")?.distinctLanes).toBe(1);
	// l1 traverses both peers: group counts overlap (2 + 1), total deduped to 2
	expect(result.totals.distinctLanes).toBe(2);
	expect(result.totals.requests).toBe(3);
});

test("origin grouping, origin/peer/project/time/outcome filters apply", () => {
	const db = store();
	ingestRequestEdges(db, [
		edge({ eventId: "a", peerHub: "hub-a", originHub: "hub-o1", laneId: "l1" }),
		edge({ eventId: "b", peerHub: "hub-a", originHub: "hub-o2", laneId: "l2", outcome: "error" }),
		edge({ eventId: "c", peerHub: "hub-b", originHub: "hub-o1", laneId: "l3", project: "/p/other/.git" }, 500),
	]);
	const byOrigin = laneModelGroups(db, filters({ group: "origin" }));
	expect(byOrigin.groupBy).toBe("origin");
	expect(byOrigin.groups.find((g) => g.hub === "hub-o1")?.distinctLanes).toBe(2);
	expect(
		laneModelGroups(db, filters({ peer: "hub-b" })).groups.map((g) => g.hub),
	).toEqual(["hub-b"]);
	expect(
		laneModelGroups(db, filters({ project: "/p/other/.git" })).groups,
	).toHaveLength(1);
	// time filter: only the recent edge survives a since = NOW - 1s window
	expect(laneModelGroups(db, filters({ since: NOW - 1_000 })).groups.map((g) => g.hub)).toEqual(["hub-b"]);
	const errors = laneModelGroups(db, filters({ outcome: "error" }));
	expect(errors.groups.map((g) => g.hub)).toEqual(["hub-a"]);
	expect(errors.totals.errors).toBe(1);
});

test("presence contributes live lanes to groups and totals without double counting", () => {
	const db = store();
	db.run(
		`INSERT INTO board_lane_observations (lane_id, project, origin_hub, peer_hub, observed_at, expires_at, visited_hubs)
		VALUES ('lane-live', '/p/repo/.git', 'hub-o', 'hub-peer', ?, ?, '["hub-o","hub-peer"]')`,
		NOW - 1_000, NOW + 300_000,
	);
	const result = laneModelGroups(db, filters());
	expect(result.groups.map((g) => g.hub)).toEqual(["hub-peer"]);
	expect(result.groups[0].distinctLanes).toBe(1);
	expect(result.totals.distinctLanes).toBe(1);
	// expired presence is invisible — unknown, never proof of lane end
	db.run("UPDATE board_lane_observations SET expires_at = 1");
	expect(laneModelGroups(db, filters()).groups).toEqual([]);
});

test("detail paginates by keyset and never drifts rows across pages", () => {
	const db = store();
	ingestRequestEdges(
		db,
		// ages 9..5s → ts strictly descending, so id order == recency order
		Array.from({ length: 5 }, (_, i) => edge({ eventId: `p${i}`, requestId: `r${i}` }, 9_000 - i)),
	);
	const page1 = laneModelDetail(db, filters(), null, 2);
	expect(page1.rows.map((r) => r.requestId)).toEqual(["r4", "r3"]);
	expect(page1.nextCursor).toBe(page1.rows.at(-1)?.id);
	const page2 = laneModelDetail(
		db,
		filters(),
		page1.nextCursor as number,
		2,
	);
	expect(page2.rows.map((r) => r.requestId)).toEqual(["r2", "r1"]);
	const page3 = laneModelDetail(db, filters(), page2.nextCursor as number, 2);
	expect(page3.rows.map((r) => r.requestId)).toEqual(["r0"]);
	expect(page3.nextCursor).toBeNull();
});

test("filter parsing rejects malformed scopes without throwing", () => {
	const url = (qs: string) => new URL(`http://x/api/lane-model/groups${qs}`);
	expect(parseLaneModelFilters(url("?outcome=weird"))).toContain("outcome");
	expect(parseLaneModelFilters(url("?group=tree"))).toContain("group");
	expect(parseLaneModelFilters(url("?until=5&since=10"))).toContain("window");
	const f = parseLaneModelFilters(url("?project=/p/.git&origin=hub-a"));
	expect(typeof f === "string" ? null : f.project).toBe("/p/.git");
	expect(typeof f === "string" ? null : f.group).toBe("peer");
});

test("delta streams bounded rows and flags overflow for resync", () => {
	const db = store();
	ingestRequestEdges(db, [edge({ eventId: "x1", requestId: "r1" }, 9_000)]);
	const fresh = laneModelDelta(db, filters(), 0);
	expect(fresh.overflow).toBe(false);
	expect(fresh.rows).toHaveLength(1);
	const empty = laneModelDelta(db, filters(), fresh.cursor);
	expect(empty.rows).toEqual([]);
	ingestRequestEdges(
		db,
		Array.from({ length: 70 }, (_, i) => edge({ eventId: `d${i}`, requestId: `r${i}` }, 500)),
	);
	const overflow = laneModelDelta(db, filters(), 0);
	expect(overflow.overflow).toBe(true);
	expect(overflow.rows).toEqual([]);
	expect(overflow.cursor).toBeGreaterThan(fresh.cursor);
	const resumed = laneModelDelta(db, filters(), overflow.cursor);
	expect(resumed.overflow).toBe(false);
	expect(resumed.rows.length).toBeLessThanOrEqual(64);
});

test("edge and descriptor tables stay bounded", () => {
	const db = store();
	const rows = Array.from({ length: EDGE_ROW_CAP + 150 }, (_, i) =>
		edge({ eventId: `c${i}`, requestId: `q${i}` }, 5_000),
	);
	// ingest caps batches at 200 — feed through repeated valid batches
	let accepted = 0;
	for (let i = 0; i < rows.length; i += 200) {
		const result = ingestRequestEdges(db, rows.slice(i, i + 200));
		if (result.ok) accepted += result.accepted;
	}
	expect(accepted).toBe(EDGE_ROW_CAP + 150);
	const edges = (db.query("SELECT COUNT(*) AS n FROM board_request_edges").get() as { n: number }).n;
	const descriptors = (
		db.query("SELECT COUNT(*) AS n FROM board_lane_descriptors").get() as { n: number }
	).n;
	expect(edges).toBeLessThanOrEqual(EDGE_ROW_CAP);
	expect(descriptors).toBeLessThanOrEqual(5_000);
});

test("presence projection folds observations into per-observer rows exactly once per observer", () => {
	const db = store();
	db.run(
		`INSERT INTO board_lane_observations (lane_id, project, origin_hub, peer_hub, observed_at, expires_at, visited_hubs)
		VALUES ('lane-p', '/p/repo/.git', 'hub-o', 'hub-peer', ?, ?, '["hub-o"]')`,
		NOW - 1_000, NOW + 300_000,
	);
	expect(projectPresence(db, NOW)).toBe(1);
	expect(projectPresence(db, NOW)).toBe(1);
	const rows = db
		.query("SELECT * FROM board_observer_presence")
		.all() as Record<string, number | string>[];
	expect(rows).toHaveLength(1);
	expect(rows[0].observer_hub).toBe("hub-peer");
	expect(rows[0].origin_hub).toBe("hub-o");
});
