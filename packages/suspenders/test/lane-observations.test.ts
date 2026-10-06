import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	ensureLaneObservations,
	laneObservationSnapshot,
	recordLaneObservation,
} from "../hooks/board/lane-observations.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const now = 2_000_000;
const observation = {
	laneId: "lane-a",
	project: "/fleet/.git",
	originHub: "spoke-a",
	peerHub: "team-hub",
	observedAt: now,
	expiresAt: now + 60_000,
};
function fixture() {
	const db = new Database(":memory:") as unknown as GovernorStore;
	ensureLaneObservations(db);
	return db;
}

test("records bounded read-only observations with origin distinct from immediate peer", () => {
	const db = fixture();
	expect(recordLaneObservation(db, observation, now)).toEqual({ ok: true });
	expect(
		recordLaneObservation(db, { ...observation, peerHub: "second-hub" }, now)
			.ok,
	).toBe(true);
	const snapshot = laneObservationSnapshot(db, "/fleet/.git", now);
	expect(snapshot.lanes).toHaveLength(2);
	expect(snapshot.origins).toEqual(["spoke-a"]);
	expect(snapshot.peers).toEqual(["second-hub", "team-hub"]);
	expect(laneObservationSnapshot(db, "/other/.git", now).lanes).toHaveLength(0);
	expect(laneObservationSnapshot(db, null, now + 60_000).lanes).toHaveLength(0);
	expect(
		db.query("SELECT name FROM sqlite_master WHERE name = 'work_items'").all(),
	).toHaveLength(0);
	db.close();
});

test("rejects malformed identity and unbounded, future or expired observations", () => {
	const db = fixture();
	for (const invalid of [
		null,
		[],
		{ ...observation, laneId: "" },
		{ ...observation, project: "x\u0000y" },
		{ ...observation, originHub: "unknown" },
		{ ...observation, peerHub: "all" },
		{ ...observation, originHub: "x".repeat(129) },
		{ ...observation, observedAt: now + 5_001 },
		{ ...observation, expiresAt: now },
		{ ...observation, expiresAt: now + 86_400_001 },
		{ ...observation, observedAt: Number.NaN },
		{ ...observation, visitedHubs: ["A", "A"] },
		{ ...observation, visitedHubs: ["unknown"] },
		{
			...observation,
			visitedHubs: Array.from({ length: 17 }, (_, i) => `hub-${i}`),
		},
	])
		expect(recordLaneObservation(db, invalid, now).ok).toBe(false);
	expect(laneObservationSnapshot(db, null, now).lanes).toHaveLength(0);
	db.close();
});

test("delayed replay cannot overwrite a more recent observation", () => {
	const db = fixture();
	recordLaneObservation(db, observation, now);
	recordLaneObservation(
		db,
		{ ...observation, observedAt: now - 1000, expiresAt: now + 500 },
		now,
	);
	expect(laneObservationSnapshot(db, null, now).lanes[0]?.expiresAt).toBe(
		observation.expiresAt,
	);
	db.close();
});

test("observation storage is bounded across distinct lane identities", () => {
	const db = fixture();
	for (let i = 0; i < 1002; i++)
		recordLaneObservation(
			db,
			{ ...observation, laneId: `lane-${i}`, observedAt: now + i },
			now,
		);
	const snapshot = laneObservationSnapshot(db, null, now);
	expect(snapshot.lanes).toHaveLength(1000);
	expect(snapshot.lanes.some((lane) => lane.laneId === "lane-0")).toBe(false);
	db.close();
});
