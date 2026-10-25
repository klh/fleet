// W1280 regressions — capacity-aware review admission and stale-leg recovery.
// Pressure (AIMD off provider outcome signals) and reconcile (pid liveness)
// live in review-scheduler.ts; these tests time-travel by rewriting the
// ledger rows (the established pattern in review-scheduler.test.ts).
import { afterEach, expect, test } from "bun:test";
import {
	openMemoryStore,
	type GovernorStore,
} from "../hooks/lib/govdb-store.ts";
import {
	finishReviewRequest,
	reviewRequestKey,
	providerPressureKey,
	providerPressureOf,
	reconcileReviewLegs,
	scheduleReview,
	stampReviewPid,
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
	return {
		db,
		context,
		options,
		launches,
		spawn: (args: string[]) => launches.push(args),
	};
}
const keyOf = (f: ReturnType<typeof fixture>, item: string): string =>
	reviewRequestKey("fixture", item, f.context);
const requestOf = (
	f: ReturnType<typeof fixture>,
	item = "W1",
): {
	token: string;
	state: string;
	attempts: number;
	nextAt: number;
} =>
	JSON.parse(
		(
			f.db.query("SELECT value FROM facts WHERE key=?").get(keyOf(f, item)) as {
				value: string;
			}
		).value,
	);
const setPressure = (
	f: ReturnType<typeof fixture>,
	p: Partial<{ fails: number; openUntil: number }>,
): void => {
	const now = Date.now();
	const current = providerPressureOf(f.db);
	f.db
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
		)
		.run(
			providerPressureKey,
			JSON.stringify({ ...current, updated: now, ...p }),
			now,
		);
};
/** Schedule, then fail the leg — one storm iteration. The pause window and
 * the per-request backoff from earlier failures are forced expired first
 * (time passed between admissions); the failure MEMORY (fails count) stays —
 * only the windows gate, and they were given time to lapse. */
function failOnce(f: ReturnType<typeof fixture>, item = "W1"): void {
	setPressure(f, { openUntil: Date.now() - 1 });
	const row = f.db
		.query("SELECT value FROM facts WHERE key=?")
		.get(keyOf(f, item)) as { value: string } | null;
	if (row) {
		const held = JSON.parse(row.value) as { nextAt: number };
		held.nextAt = 0;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(held), keyOf(f, item));
	}
	expect(scheduleReview({ ...f.options, item, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	finishReviewRequest(f.db, keyOf(f, item), requestOf(f, item).token, true);
}
test("transport failure opens a global pressure pause that defers new admissions", () => {
	const f = fixture();
	failOnce(f);
	const pressure = providerPressureOf(f.db);
	expect(pressure.fails).toBe(1);
	expect(pressure.openUntil).toBeGreaterThan(Date.now());
	// a different, fresh exact context is deferred without reserving
	const before = f.launches.length;
	expect(
		scheduleReview({ ...f.options, item: "W2", spawn: f.spawn }),
	).toContain("provider pressure");
	expect(f.launches).toHaveLength(before);
});
test("expired pause reopens admission — backlog drains without terminal exhaustion", () => {
	const f = fixture();
	for (let round = 0; round < 3; round += 1) {
		failOnce(f);
		// time passes: pause expires and the request's own deferral is due
		setPressure(f, { openUntil: Date.now() - 1 });
		const held = requestOf(f);
		held.nextAt = 0;
		f.db
			.query("UPDATE facts SET value=? WHERE key=?")
			.run(JSON.stringify(held), f.key);
	}
	// three storm rounds consumed zero verdict budget — admission reopened
	setPressure(f, { openUntil: Date.now() - 1 });
	const held = requestOf(f);
	held.nextAt = 0;
	f.db
		.query("UPDATE facts SET value=? WHERE key=?")
		.run(JSON.stringify(held), keyOf(f, "W1"));
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
});
test("served verdict decays pressure but an active cooldown survives isolated success", () => {
	const f = fixture();
	// saturate: two failed admissions (pause forced open between them)
	failOnce(f, "W1");
	setPressure(f, { openUntil: Date.now() + 600_000, fails: 1 });
	failOnce(f, "W2");
	expect(providerPressureOf(f.db).fails).toBe(2);
	// one isolated success mid-storm must NOT cancel the 429 cooldown (#70140):
	// re-admit W2 (window lapsed, memory kept), finish it DONE
	const w2 = requestOf(f, "W2");
	w2.state = "RUNNING";
	f.db
		.query("UPDATE facts SET value=? WHERE key=?")
		.run(JSON.stringify(w2), keyOf(f, "W2"));
	finishReviewRequest(f.db, keyOf(f, "W2"), w2.token, false);
	const decayed = providerPressureOf(f.db);
	expect(decayed.fails).toBe(1); // 2 → 1: halved, not cleared
	expect(decayed.openUntil).toBeGreaterThan(Date.now() - 1); // floor kept
});
test("reopen stagger spreads the deferred backlog instead of a herd", () => {
	const f = fixture();
	const items = ["W1", "W2", "W3"];
	for (const item of items) failOnce(f, item);
	// pause active with a window longer than the per-request backoff (2m):
	// every leg defers to a jittered slot inside [openUntil, openUntil+90s)
	setPressure(f, { openUntil: Date.now() + 600_000 });
	const slots: number[] = [];
	for (const item of items) {
		scheduleReview({ ...f.options, item, spawn: f.spawn });
		const nextAt = requestOf(f, item).nextAt;
		expect(nextAt).toBeGreaterThan(Date.now() + 600_000);
		expect(nextAt).toBeLessThanOrEqual(Date.now() + 690_000);
		slots.push(nextAt);
	}
	expect(new Set(slots).size).toBe(3);
});
test("reconcile finishes a dead reviewer's lease now, spares live and legacy legs", () => {
	const f = fixture();
	for (const item of ["W1", "W2", "W3"])
		scheduleReview({ ...f.options, item, spawn: f.spawn });
	// legacy leg (W1) keeps no pid — the lease expiry stays its only backstop
	// dead leg (W2): a process that already exited
	const dead = Bun.spawnSync(["/bin/sleep", "0"]);
	stampReviewPid(f.db, keyOf(f, "W2"), requestOf(f, "W2").token, dead.pid);
	// live leg (W3): a real process that outlives the sweep
	const live = Bun.spawn(["/bin/sleep", "30"]);
	stampReviewPid(f.db, keyOf(f, "W3"), requestOf(f, "W3").token, live.pid);
	const summary = reconcileReviewLegs(f.db);
	expect(summary).toEqual({ examined: 3, active: 1, stale: 1, recovered: 1 });
	const recovered = requestOf(f, "W2");
	expect(recovered.state).toBe("ERROR");
	expect(recovered.attempts).toBe(0); // verdict budget refunded
	live.kill();
});
