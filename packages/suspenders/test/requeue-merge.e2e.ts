// test/requeue-merge.e2e.ts — W2330: the monotone requeue-merge rule
// (Kueue SetRequeueState, pkg/workload/workload.go:973) at its three
// writer surfaces. The rule itself lives in launch-fencing.ts
// (mergeRequeueState, the W2313 lifecycle home); these specs pin its
// invariants at the writers that can fight over one item.

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	clearDeferral,
	deferItem,
	deferralOf,
} from "../scripts/lib/dispatch-defers.ts";
import {
	readLaunchBackoff,
	rearmLaunchHold,
	scheduleLaunchBackoff,
} from "../scripts/lib/launch-backoff.ts";
import { mergeRequeueState } from "../scripts/lib/launch-fencing.ts";

/** The launch-backoff store fixture (same shape as launch-backoff.test.ts):
 *  facts + events is all scheduleLaunchBackoff touches. */
function backoffFixture(): { db: Database; store: GovernorStore } {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,updated_at INTEGER,state TEXT,scope TEXT)",
	);
	return { db, store: db as unknown as GovernorStore };
}

test.describe("@unit W2330 requeue-merge rule", () => {
	test("later wall wins; earlier never clobbers later", () => {
		const later = { requeueAt: 10_000, count: 2 };
		expect(
			mergeRequeueState(later, { requeueAt: 5_000, count: 3 }, true),
		).toEqual({ requeueAt: 10_000, count: 3 });
		// a fresh candidate past the prior wall advances it
		expect(
			mergeRequeueState(later, { requeueAt: 20_000, count: 3 }, true),
		).toEqual({ requeueAt: 20_000, count: 3 });
		// no prior: the candidate stands as-is
		expect(
			mergeRequeueState(null, { requeueAt: 5_000, count: 1 }, true),
		).toEqual({ requeueAt: 5_000, count: 1 });
	});

	test("count increments only on attempt-scoped evidence (W1165)", () => {
		const prior = { requeueAt: 10_000, count: 4 };
		// evidence-free re-arm: count and wall carry over unchanged
		expect(
			mergeRequeueState(prior, { requeueAt: 999, count: 5 }, false),
		).toEqual({ requeueAt: 10_000, count: 4 });
		// evidence-bearing: the count moves
		expect(
			mergeRequeueState(prior, { requeueAt: 999, count: 5 }, true),
		).toEqual({ requeueAt: 10_000, count: 5 });
		// evidence-free with no prior mints nothing: wall keeps the candidate
		expect(
			mergeRequeueState(null, { requeueAt: 999, count: 5 }, false),
		).toEqual({ requeueAt: 999, count: 0 });
	});
});

test.describe("@unit W2330 backoff writer monotone", () => {
	test("an evidence-free re-arm never mints a rung or clobbers a later wall", () => {
		const { db, store } = backoffFixture();
		try {
			// attempt-scoped evidence mints rung 1
			const first = scheduleLaunchBackoff(
				store,
				"p",
				"W1",
				"/lane.log",
				0,
				1_000,
				"HTTP 429 Retry-After: 43",
			);
			expect(first.failures).toBe(1);
			expect(first.eligibleAt).toBe(44_000);
			// evidence-free re-arm (no new native launch): the count and wall
			// re-present, never mint a fresh rung
			const rearm = rearmLaunchHold(store, "p", "W1", "/lane.log", 0);
			expect(rearm.failures).toBe(1);
			expect(rearm.eligibleAt).toBeGreaterThanOrEqual(44_000);
			expect(readLaunchBackoff(store, "p", "W1")?.failures).toBe(1);
		} finally {
			db.close();
		}
	});

	test("evidence-bearing failures climb the merged ladder", () => {
		const { db, store } = backoffFixture();
		try {
			const first = scheduleLaunchBackoff(
				store,
				"p",
				"W2",
				"/lane.log",
				0,
				1_000,
				"HTTP 429 too many requests",
			);
			expect(first.failures).toBe(1);
			const second = scheduleLaunchBackoff(
				store,
				"p",
				"W2",
				"/lane.log",
				1,
				2_000,
				"HTTP 429 too many requests",
			);
			expect(second.failures).toBe(2);
			expect(second.eligibleAt).toBeGreaterThan(first.eligibleAt);
		} finally {
			db.close();
		}
	});
});

test.describe("@unit W2330 defers writer monotone", () => {
	const world = scratchWorld();
	test.afterAll(() => world.clean());
	const fleetDir = join(world.repo, ".fleet");

	test("a deferral never clobbers a later pending requeueAt", () => {
		const id = `w2330-defer-${Date.now()}`;
		deferItem(id, undefined, undefined, fleetDir);
		const first = deferralOf(fleetDir, id);
		expect(first?.failures).toBe(1);
		// hand-place a LATER pending wall, then defer again: the earlier
		// ladder candidate must not pull it back
		const placed = writeLaterWall(
			fleetDir,
			id,
			(first?.requeueAt ?? 0) + 120_000,
		);
		expect(placed.requeueAt).toBeGreaterThan(first?.requeueAt ?? 0);
		deferItem(id, undefined, undefined, fleetDir);
		const merged = deferralOf(fleetDir, id);
		expect(merged?.failures).toBe(2);
		expect(merged?.requeueAt).toBe(placed.requeueAt);
		clearDeferral(fleetDir, id);
		expect(deferralOf(fleetDir, id)).toBeNull();
	});
});

/** Test seam: place a later wall by hand (the file is the W2315 store);
 *  returns the row as persisted. */
function writeLaterWall(
	fleetDir: string,
	item: string,
	requeueAt: number,
): { item: string; requeueAt: number } {
	const file = join(fleetDir, "dispatch-defers.json");
	const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{
		item: string;
		failures: number;
		requeueAt: number;
	}>;
	const next = rows.map((r) => (r.item === item ? { ...r, requeueAt } : r));
	writeFileSync(file, JSON.stringify(next, null, "\t"));
	return next.find((r) => r.item === item) as {
		item: string;
		requeueAt: number;
	};
}
