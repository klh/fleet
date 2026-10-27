import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	classifyLaunchFailure,
	parkExhaustedLaunch,
	readLaunchBackoff,
	scheduleLaunchBackoff,
} from "../scripts/lib/launch-backoff.ts";

function fixture() {
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
	db.run("CREATE TABLE claims(sid TEXT,scope TEXT,intent TEXT)");
	db.run(
		"INSERT INTO work_items VALUES ('p','W1','lane',100,'CLAIMED','scope')",
	);
	return { db, store: db as unknown as GovernorStore };
}

test("classifies provider backpressure and honors Retry-After", () => {
	expect(
		classifyLaunchFailure("HTTP 429 too many requests; Retry-After: 43", 1_000),
	).toEqual({
		kind: "rate-limit",
		code: "429",
		retryAfterMs: 43_000,
	});
	expect(classifyLaunchFailure("API Error: 502 no_route").kind).toBe(
		"upstream",
	);
	expect(classifyLaunchFailure("ECONNRESET").kind).toBe("transport");
	expect(classifyLaunchFailure("error: unknown option '--sandbox'").kind).toBe(
		"configuration",
	);
	expect(
		classifyLaunchFailure("UnsupportedParamsError: presence_penalty").kind,
	).toBe("configuration");
});

test("retry steps increase, preserve the original evidence location, and respect the provider delay", () => {
	const { db, store } = fixture();
	const first = scheduleLaunchBackoff(
		store,
		"p",
		"W1",
		"/lane.log",
		0,
		1_000,
		"HTTP 429 Retry-After: 43",
	);
	expect(first.eligibleAt).toBe(44_000);
	const second = scheduleLaunchBackoff(
		store,
		"p",
		"W1",
		"/lane.log",
		1,
		44_000,
		"HTTP 502 no_route",
	);
	expect(second.eligibleAt).toBeGreaterThanOrEqual(54_000);
	expect(second.firstAt).toBe(1_000);
	expect(second.failures).toBe(2);
	expect(readLaunchBackoff(store, "p", "W1")?.log).toBe("/lane.log");
	expect(
		db
			.query(
				"SELECT count(*) AS n FROM events WHERE kind='lane.launch-backoff'",
			)
			.get(),
	).toEqual({ n: 2 });
	db.close();
});

test("exhausted dead launch returns the same work item to READY and resets its budget", () => {
	const { db, store } = fixture();
	db.run(
		"CREATE TABLE lane_launch_budgets(project TEXT,item TEXT,reservations INTEGER,PRIMARY KEY(project,item))",
	);
	db.run("INSERT INTO lane_launch_budgets VALUES ('p','W1',3)");
	db.run(
		"INSERT INTO facts VALUES ('lane.lane.launch-attempt','2','dispatch',1,100)",
	);
	const parked = parkExhaustedLaunch(
		store,
		"p",
		"W1",
		"lane",
		"/lane.log",
		3,
		1_000,
	);
	expect(parked?.kind).toBe("unknown");
	expect(
		db.query("SELECT state,owner_sid FROM work_items WHERE id='W1'").get(),
	).toEqual({ state: "READY", owner_sid: null });
	expect(db.query("SELECT * FROM lane_launch_budgets").all()).toEqual([]);
	expect(
		db.query("SELECT * FROM facts WHERE key='lane.lane.launch-attempt'").all(),
	).toEqual([]);
	expect(
		parkExhaustedLaunch(store, "p", "W1", "other", "/lane.log", 3, 1_000)?.kind,
	).toBe("unknown");
	db.close();
});
