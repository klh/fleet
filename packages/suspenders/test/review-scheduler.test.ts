import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { reviewRoundCap } from "../hooks/lib/gates/review-round-cap.ts";
import {
	finishReviewRequest,
	providerPressureKey,
	reviewRequestKey,
	scheduleReview,
} from "../hooks/lib/gates/review-scheduler.ts";
import {
	type GovernorStore,
	openMemoryStore,
} from "../hooks/lib/govdb/govdb-store.ts";

const stores: GovernorStore[] = [];
afterEach(() => {
	for (const db of stores.splice(0)) db.close();
});
/** Read the fixture's review-request fact as a typed object. */
function requestOf(f: ReturnType<typeof fixture>): {
	token: string;
	attempts: number;
	deferred?: number;
	state: string;
} {
	return JSON.parse(
		(
			f.db.query("SELECT value FROM facts WHERE key=?").get(f.key) as {
				value: string;
			}
		).value,
	);
}
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
	for (const item of ["W1", "W2", "W3"])
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
/** Simulate the pause window expiring — tests time-travel by rewriting the
 * ledger row (the established pattern for nextAt/leaseUntil). */
function setPressure(
	f: ReturnType<typeof fixture>,
	p: Partial<{ fails: number; openUntil: number }>,
): void {
	const now = Date.now();
	f.db
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
		)
		.run(
			providerPressureKey,
			JSON.stringify({ fails: 0, openUntil: 0, updated: now, ...p }),
			now,
		);
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
test("review scheduler launches the reviewer from the real hooks/bin directory", () => {
	const f = fixture();
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	const script = f.launches[0]?.[1];
	expect(script).toBe(
		new URL("../hooks/bin/review-lane.ts", import.meta.url).pathname,
	);
	expect(script && existsSync(script)).toBe(true);
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
		setPressure(f, { openUntil: 0 });
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
test("default schedule is unbounded — concurrent contexts never hit a ceiling", () => {
	const f = fixture();
	for (const item of ["W1", "W2", "W3"]) {
		expect(scheduleReview({ ...f.options, item, spawn: f.spawn })).toContain(
			"requested through Buckle",
		);
	}
	expect(f.launches).toHaveLength(3);
});
test("transport failure refunds the verdict attempt and defers without terminal exhaustion", () => {
	const f = fixture();
	for (let i = 0; i < 8; i += 1) {
		expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
			"requested through Buckle",
		);
		const request = requestOf(f);
		finishReviewRequest(f.db, f.key, request.token, true);
		setPressure(f, { openUntil: 0 });
		const after = requestOf(f);
		// transport ERROR never completes the request — never a mergeable PASS
		expect(after.state).toBe("ERROR");
		// the verdict budget is refunded — eight failures consumed none
		expect(after.attempts).toBe(0);
		expect(after.deferred).toBe(i + 1);
		after.nextAt = 0;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(after), f.key);
	}
	// bounded backoff, never a terminal stop: the 9th schedule still runs
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
});
test("expired RUNNING lease (crashed reviewer) refunds and defers — crashes never exhaust the budget", () => {
	const f = fixture();
	for (let i = 0; i < 5; i += 1) {
		expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
			"requested through Buckle",
		);
		const request = requestOf(f);
		// the runner dies without finishing: expire the lease in place
		request.leaseUntil = Date.now() - 1;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(request), f.key);
		// re-scheduling treats it as a transport deferral — no launch
		expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
			"review transport retry deferred until",
		);
		const crashed = requestOf(f);
		expect(crashed.state).toBe("ERROR");
		expect(crashed.attempts).toBe(0);
		expect(crashed.deferred).toBe(i + 1);
		crashed.nextAt = 0;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(crashed), f.key);
	}
	// five crashes never reach the terminal exhaustion gate
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
});
test("true FAIL verdict is terminal — never retried, never re-rolled", () => {
	const f = fixture();
	scheduleReview({ ...f.options, spawn: f.spawn });
	const request = requestOf(f);
	finishReviewRequest(f.db, f.key, request.token, false);
	expect(requestOf(f).state).toBe("DONE");
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"review completed; unresolved findings require repair",
	);
	expect(f.launches).toHaveLength(1);
});
/** W1303.7: the scheduler fixture plus the events + work_items tables the
 * round cap reads — the bare fixture lacks them, so every test above also
 * proves the cap fails open on an unreadable history. */
function capFixture() {
	const f = fixture();
	f.db.run(
		"CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	f.db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,parent_id TEXT,tags TEXT)",
	);
	return f;
}
/** Bank one bound review receipt for `item` at `commit`. */
function review(
	f: ReturnType<typeof fixture>,
	item: string,
	commit: string,
	verdict: "PASS" | "FAIL" | "ERROR",
	base = "b".repeat(40),
	wire?: { requested: string; served: string },
): void {
	const receipt = { version: 1, commit, base, verdict, ...wire };
	const payload = { project: "fixture", work: item, verdict };
	f.db
		.query(
			"INSERT INTO events(ts,source,kind,scope,payload) VALUES (?,'review-lane','work.review',?,?)",
		)
		.run(
			Date.now(),
			item,
			JSON.stringify({ ...payload, receipt: JSON.stringify(receipt) }),
		);
}
const decisions = (f: ReturnType<typeof fixture>) =>
	f.db
		.query("SELECT target, payload FROM events WHERE kind='NEED_DECISION'")
		.all() as { target: string; payload: string }[];
test("round cap knob: unset or junk → 3, an integer overrides, 0 disables", () => {
	expect(reviewRoundCap({})).toBe(3);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "x" })).toBe(3);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "5" })).toBe(5);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "0" })).toBe(0);
});
test("round cap: three failed review-and-fix rounds stop the reviewer and ask the author once", () => {
	const f = capFixture();
	for (const c of ["1", "2", "3"]) review(f, "W1", c.repeat(40), "FAIL");
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"review round cap reached (3 failed review rounds, cap 3)",
	);
	scheduleReview({ ...f.options, spawn: f.spawn });
	expect(f.launches).toHaveLength(0);
	const asked = decisions(f);
	expect(asked).toHaveLength(1);
	expect(asked[0]?.target).toBe("author");
	expect(JSON.parse(asked[0]?.payload ?? "{}")).toMatchObject({
		work: "W1",
		review_round_cap: "3",
	});
});
test("round cap counts commits whose latest verdict FAILED — ERROR legs and resolved commits are not rounds", () => {
	const f = capFixture();
	review(f, "W1", "1".repeat(40), "FAIL");
	review(f, "W1", "2".repeat(40), "FAIL");
	review(f, "W1", "3".repeat(40), "ERROR");
	review(f, "W1", "4".repeat(40), "FAIL");
	review(f, "W1", "4".repeat(40), "PASS");
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	expect(decisions(f)).toHaveLength(0);
});
test("W1760: a wire-model mismatch grades ERROR — an untrusted verdict never spends a round", () => {
	const f = capFixture();
	// the #78405 shape: routing fallback served local-swarm for glm-5.3, the
	// reviewer's PASS graded down to ERROR — the cap counts FAILs only, so the
	// retry on the requested class launches instead of hitting NEED_DECISION
	review(f, "W1", "1".repeat(40), "ERROR", "b".repeat(40), {
		requested: "glm-5.3-flash",
		served: "local-swarm",
	});
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	expect(decisions(f)).toHaveLength(0);
});
test("round cap counts re-reviews of an unchanged commit — each moved base that FAILs is a round", () => {
	const f = capFixture();
	for (const b of ["c", "d", "e"])
		review(f, "W1", "1".repeat(40), "FAIL", b.repeat(40));
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"review round cap reached (3 failed review rounds, cap 3)",
	);
	expect(f.launches).toHaveLength(0);
});
test("round cap: a review-repair child inherits its parent's rounds; other children and cap 0 do not", () => {
	const f = capFixture();
	for (const c of ["1", "2", "3"]) review(f, "W1", c.repeat(40), "FAIL");
	f.db.run(
		"INSERT INTO work_items VALUES ('fixture','W2','W1','fleet,repair,review'),('fixture','W3','W1','fleet,repair')",
	);
	expect(
		scheduleReview({ ...f.options, item: "W2", spawn: f.spawn }),
	).toContain("review round cap reached");
	expect(
		scheduleReview({ ...f.options, item: "W3", spawn: f.spawn }),
	).toContain("requested through Buckle");
	const env = { ...f.options.env, SUSPENDERS_REVIEW_ROUND_CAP: "0" };
	expect(scheduleReview({ ...f.options, env, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	expect(f.launches).toHaveLength(2);
	expect(decisions(f).map((d) => d.target)).toEqual(["author"]);
});
