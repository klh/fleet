import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	OBSERVATION_FRESHNESS_MS,
	OBSERVATION_OUTBOX_CAPACITY,
	appendObservation,
	ingestObservations,
	markObserverDisconnected,
	observationStoreId,
	projectLanes,
	type ObservationEvent,
} from "./observation-plane.ts";

const NOW = 1_700_000_000_000;

function db(): Database {
	return new Database(":memory:");
}

function ev(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
	return {
		id: crypto.randomUUID(),
		source: "store-a",
		bootId: "boot-1",
		seq: 1,
		type: "lane.presence",
		projectId: "/repo/.git",
		laneId: "autow621",
		sourceTime: NOW,
		...overrides,
	};
}

describe("observation plane ingest", () => {
	test("replayed batches dedup on (source, id) and do not double-count", () => {
		const d = db();
		const batch = [ev({ seq: 1 }), ev({ seq: 2, type: "request.started" })];
		const first = ingestObservations(d, batch, NOW);
		expect(first.accepted).toBe(2);
		const replay = ingestObservations(d, batch, NOW + 1);
		expect(replay.accepted).toBe(0);
		expect(replay.duplicates).toBe(2);
	});

	test("malformed payloads count as invalid, not duplicates", () => {
		const d = db();
		const r = ingestObservations(d, [{ garbage: true }, "nope"], NOW);
		expect(r.invalid).toBe(2);
		expect(r.accepted).toBe(0);
	});

	test("sequence gaps are detected per (source, bootId), not guessed away", () => {
		const d = db();
		const r = ingestObservations(d, [ev({ seq: 1 }), ev({ seq: 4 })], NOW);
		expect(r.accepted).toBe(2);
		expect(r.gaps).toEqual([{ from: 2, to: 3 }]);
	});

	test("events from a disconnected observer boot are rejected (stale generation)", () => {
		const d = db();
		ingestObservations(d, [ev({ seq: 1 })], NOW);
		expect(markObserverDisconnected(d, "store-a", "boot-1", NOW + 10)).toBe(
			true,
		);
		const late = ingestObservations(d, [ev({ seq: 2 })], NOW + 20);
		expect(late.rejectedStaleGeneration).toBe(1);
		expect(late.accepted).toBe(0);
		// a new incarnation is a fresh generation, never blocked by the old
		const reborn = ingestObservations(
			d,
			[ev({ seq: 1, bootId: "boot-2" })],
			NOW + 30,
		);
		expect(reborn.accepted).toBe(1);
		expect(reborn.rejectedStaleGeneration).toBe(0);
	});

	test("disconnect is idempotent and false for unknown boots", () => {
		const d = db();
		expect(markObserverDisconnected(d, "store-a", "ghost", NOW)).toBe(false);
		ingestObservations(d, [ev({ seq: 1 })], NOW);
		expect(markObserverDisconnected(d, "store-a", "boot-1", NOW)).toBe(true);
		expect(markObserverDisconnected(d, "store-a", "boot-1", NOW)).toBe(false);
	});
});

describe("observation plane outbox", () => {
	test("capacity is an explicit overflow, never silent loss", () => {
		const d = db();
		for (let i = 0; i < OBSERVATION_OUTBOX_CAPACITY; i++)
			appendObservation(d, ev({ id: `e${i}`, seq: i + 1 }), NOW);
		expect(() => appendObservation(d, ev({ id: "overflow" }), NOW)).toThrow(
			"Observation outbox capacity reached",
		);
	});

	test("store id is stable per store", () => {
		const d = db();
		expect(observationStoreId(d)).toBe(observationStoreId(d));
	});
});

describe("visibility split", () => {
	function seeded(): Database {
		const d = db();
		const own = observationStoreId(d);
		const t = (ms: number) => NOW - OBSERVATION_FRESHNESS_MS + ms;
		ingestObservations(
			d,
			[
				// own lane, fresh authority presence
				ev({ source: own, seq: 1, type: "lane.admitted", laneId: "lane-own" }),
				ev({
					source: own,
					seq: 2,
					type: "lane.presence",
					laneId: "lane-own",
					sourceTime: t(1000),
				}),
				ev({
					source: own,
					seq: 3,
					type: "request.ended",
					laneId: "lane-own",
					requestId: "r-own",
					outcome: "ok",
					latencyMs: 1200,
					sourceTime: t(1500),
				}),
				// own lane, STALE presence — unknown, never dead
				ev({
					source: own,
					seq: 3,
					type: "lane.admitted",
					laneId: "lane-stale",
					sourceTime: NOW - OBSERVATION_FRESHNESS_MS * 3,
				}),
				// pass-through traffic from a foreign hub observer
				ev({
					source: "store-b",
					bootId: "boot-b",
					seq: 1,
					type: "lane.presence",
					laneId: "lane-foreign",
					projectId: "/other/.git",
				}),
				ev({
					source: "store-b",
					bootId: "boot-b",
					seq: 2,
					type: "request.started",
					laneId: "lane-foreign",
					requestId: "r1",
					projectId: "/other/.git",
				}),
				ev({
					source: "store-b",
					bootId: "boot-b",
					seq: 3,
					type: "request.ended",
					laneId: "lane-foreign",
					requestId: "r1",
					outcome: "ok",
					latencyMs: 420,
					projectId: "/other/.git",
					sourceTime: t(2000),
				}),
			],
			NOW,
		);
		return d;
	}

	test("owner sees full detail with authority-derived status", () => {
		const view = projectLanes(seeded(), { visibility: "owns" }, NOW);
		const own = view.lanes.find((l) => l.laneId === "lane-own");
		expect(own?.status).toBe("active");
		expect(own?.detail).not.toBeNull();
	});

	test("stale authority presence is unknown — the word dead never appears", () => {
		const d = seeded();
		const view = projectLanes(d, { visibility: "owns" }, NOW);
		const stale = view.lanes.find((l) => l.laneId === "lane-stale");
		expect(stale?.status).toBe("unknown");
		const blob = JSON.stringify(view);
		expect(blob.includes("dead")).toBe(false);
	});

	test("authorized viewer scoped to a project sees only that scope", () => {
		const view = projectLanes(
			seeded(),
			{ visibility: "authorized", projectIds: ["/other/.git"] },
			NOW,
		);
		expect(view.lanes.map((l) => l.laneId)).toEqual(["lane-foreign"]);
	});

	test("observes viewer gets counts and latency, no detail, status unknown", () => {
		const view = projectLanes(
			seeded(),
			{ visibility: "observes", projectIds: ["/other/.git"] },
			NOW,
		);
		expect(view.counts.lanes).toBe(1);
		expect(view.counts.requests).toBe(1);
		expect(view.counts.errors).toBe(0);
		expect(view.latencyMs.avg).toBe(420);
		expect(view.latencyMs.max).toBe(420);
		for (const lane of view.lanes) {
			expect(lane.status).toBe("unknown");
			expect(lane.detail).toBeNull();
		}
	});

	test("observer disconnect turns observed traffic stale but asserts nothing", () => {
		const d = seeded();
		markObserverDisconnected(d, "store-b", "boot-b", NOW);
		const view = projectLanes(
			d,
			{ visibility: "observes", projectIds: ["/other/.git"] },
			NOW,
		);
		// history remains queryable — a last value is not a health verdict
		expect(view.counts.lanes).toBe(1);
		expect(view.lanes[0]?.status).toBe("unknown");
	});
});
