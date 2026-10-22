import { afterEach, expect, test } from "bun:test";
import {
	openMemoryStore,
	type GovernorStore,
} from "../hooks/lib/govdb-store.ts";
import {
	scheduleReview,
	finishReviewRequest,
	reviewRequestKey,
} from "../hooks/lib/review-scheduler.ts";
const stores: GovernorStore[] = [];
afterEach(() => {
	for (const db of stores.splice(0)) db.close();
});
function fixture() {
	const db = openMemoryStore();
	stores.push(db);
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
	);
	const context = {
		commit: "a".repeat(40),
		base: "b".repeat(40),
		instructions: {},
		text: "",
	};
	for (const item of ["W1", "W2"])
		db.query(
			"INSERT INTO work_completion_records VALUES ('fixture',?,?,'author')",
		).run(item, context.commit);
	const options = {
		db,
		project: "fixture",
		item: "W1",
		repo: ".",
		context,
		env: { SUSPENDERS_REVIEW_MODEL: "fixture-model" },
	};
	const launches: string[][] = [];
	const spawn = (args: string[]) => {
		launches.push(args);
	};
	return {
		db,
		context,
		options,
		launches,
		spawn,
		key: reviewRequestKey("fixture", "W1", context),
	};
}
test("exact context schedules once, never direct provider or repeated per cycle", () => {
	const f = fixture();
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	scheduleReview({ ...f.options, spawn: f.spawn });
	expect(f.launches).toHaveLength(1);
	expect(f.launches[0]).toContain("--buckle");
	expect(f.launches[0]).not.toContain("--llm-url");
	const request = JSON.parse(
		(
			f.db.query("SELECT value FROM facts WHERE key=?").get(f.key) as {
				value: string;
			}
		).value,
	);
	finishReviewRequest(f.db, f.key, request.token, false);
	scheduleReview({ ...f.options, spawn: f.spawn });
	expect(f.launches).toHaveLength(1);
});
test("errors back off and stop after three attempts; stale worker cannot finish newer lease", () => {
	const f = fixture();
	let firstToken = "";
	for (let i = 0; i < 3; i += 1) {
		scheduleReview({ ...f.options, spawn: f.spawn });
		const request = JSON.parse(
			(
				f.db.query("SELECT value FROM facts WHERE key=?").get(f.key) as {
					value: string;
				}
			).value,
		);
		if (i === 0) firstToken = request.token;
		if (i === 1) {
			finishReviewRequest(f.db, f.key, firstToken, false);
			expect(
				JSON.parse(
					(
						f.db.query("SELECT value FROM facts WHERE key=?").get(f.key) as {
							value: string;
						}
					).value,
				).state,
			).toBe("RUNNING");
		}
		finishReviewRequest(f.db, f.key, request.token, true);
		scheduleReview({ ...f.options, spawn: f.spawn });
		expect(f.launches).toHaveLength(i + 1);
		request.state = "ERROR";
		request.leaseUntil = 0;
		request.nextAt = 0;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(request), f.key);
	}
	scheduleReview({ ...f.options, spawn: f.spawn });
	expect(f.launches).toHaveLength(3);
});
test("shared review capacity defers another exact context without reserving it", () => {
	const f = fixture();
	const options = {
		...f.options,
		env: { ...f.options.env, SUSPENDERS_REVIEW_CONCURRENCY: "1" },
	};
	scheduleReview({ ...options, spawn: f.spawn });
	scheduleReview({ ...options, item: "W2", spawn: f.spawn });
	expect(f.launches).toHaveLength(1);
	expect(
		(f.db.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
	).toBe(1);
});
test("missing model fails closed without a guessed provider or request lease", () => {
	const f = fixture();
	expect(scheduleReview({ ...f.options, env: {}, spawn: f.spawn })).toContain(
		"configure SUSPENDERS_REVIEW_MODEL",
	);
	expect(f.launches).toHaveLength(0);
});
