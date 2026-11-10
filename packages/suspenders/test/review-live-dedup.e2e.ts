// test/review-live-dedup.e2e.ts — W2955: review-crank trigger dedup.
// W2946 made a review VALID across base moves; this guard stops the
// re-INVOCATION spend: at most one live review per (branch, label-event).
// A later label event re-keys the request (commit/base/instructions), so
// without the guard each landing in a wave fires a fresh model leg while
// the previous leg still holds its 25-minute lease.

import { expect, test } from "@playwright/test";
import {
	liveReviewLeg,
	liveReviewRefusal,
} from "../hooks/lib/gates/review-live-dedup.ts";
import {
	finishReviewRequest,
	reviewRequestKey,
	scheduleReview,
} from "../hooks/lib/gates/review-scheduler.ts";
import {
	type GovernorStore,
	openMemoryStore,
} from "../hooks/lib/govdb/govdb-store.ts";

const base1 = "b".repeat(40);
const base2 = "c".repeat(40);
const commit = "a".repeat(40);

function fixture() {
	const db: GovernorStore = openMemoryStore();
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
	);
	db.query(
		"INSERT INTO work_completion_records VALUES ('p','W1',?,'author')",
	).run(commit);
	const launches: string[][] = [];
	const options = {
		db,
		project: "p",
		item: "W1",
		repo: ".",
		env: { SUSPENDERS_REVIEW_MODEL: "fixture-model" },
		spawn: (args: string[]) => {
			launches.push(args);
		},
	};
	const ctx = (b: string) => ({
		commit,
		base: b,
		instructions: {},
		text: "",
	});
	return { db, options, launches, ctx };
}

test("W2955: a second label-event rides the live leg instead of launching", () => {
	const f = fixture();
	expect(scheduleReview({ ...f.options, context: f.ctx(base1) })).toContain(
		"review requested",
	);
	const second = scheduleReview({ ...f.options, context: f.ctx(base2) });
	expect(second).toContain("already live");
	expect(f.launches).toHaveLength(1);
	// the deduped event never minted its own request row
	expect(
		f.db
			.query("SELECT value FROM facts WHERE key=?")
			.get(reviewRequestKey("p", "W1", f.ctx(base2))),
	).toBeNull();
	f.db.close();
});

test("W2955: a finished leg releases the branch for the next label-event", () => {
	const f = fixture();
	scheduleReview({ ...f.options, context: f.ctx(base1) });
	const key = reviewRequestKey("p", "W1", f.ctx(base1));
	const token = (
		JSON.parse(
			(
				f.db.query("SELECT value FROM facts WHERE key=?").get(key) as {
					value: string;
				}
			).value,
		) as { token: string }
	).token;
	finishReviewRequest(f.db, key, token, false);
	expect(scheduleReview({ ...f.options, context: f.ctx(base2) })).toContain(
		"review requested",
	);
	expect(f.launches).toHaveLength(2);
	f.db.close();
});

test("W2955: another item's live leg never blocks, legacy rows stay invisible", () => {
	const f = fixture();
	const now = Date.now();
	f.db
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES ('review.request.other',?,'review-scheduler',1,?)",
		)
		.run(
			JSON.stringify({
				state: "RUNNING",
				project: "p",
				item: "W9",
				leaseUntil: now + 60_000,
			}),
			now,
		);
	// legacy row: no project/item stamp — invisible to the probe
	f.db
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES ('review.request.legacy',?,'review-scheduler',1,?)",
		)
		.run(JSON.stringify({ state: "RUNNING", leaseUntil: now + 60_000 }), now);
	expect(liveReviewLeg(f.db, "p", "W1", "k", now)).toBeNull();
	expect(scheduleReview({ ...f.options, context: f.ctx(base1) })).toContain(
		"review requested",
	);
	f.db.close();
});

test("W2955: an expired lease is not live; the refusal names the holder", () => {
	const f = fixture();
	const now = Date.now();
	f.db
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES ('review.request.stale',?,'review-scheduler',1,?)",
		)
		.run(
			JSON.stringify({
				state: "RUNNING",
				project: "p",
				item: "W1",
				leaseUntil: now - 1,
			}),
			now,
		);
	expect(liveReviewLeg(f.db, "p", "W1", "k", now)).toBeNull();
	expect(
		liveReviewRefusal("W1", { key: "review.request.x", leaseUntil: now }),
	).toContain("review.request.x");
	f.db.close();
});
