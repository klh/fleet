import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	failureFingerprint,
	recordFailure,
	resolveFailures,
	type FailureContext,
} from "../hooks/lib/failure-recovery.ts";

const dbs: Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
function database(): Database {
	const db = new Database(":memory:");
	dbs.push(db);
	db.run("CREATE TABLE sessions (sid TEXT, project TEXT, state TEXT)");
	db.run(
		"CREATE TABLE consults (id INTEGER PRIMARY KEY, project TEXT, asker_sid TEXT, expert_sid TEXT, question TEXT, scope TEXT, state TEXT, created_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run("INSERT INTO sessions VALUES ('holder', 'project', 'RUNNING')");
	return db;
}
const context: FailureContext = {
	project: "project",
	sid: "asker",
	operation: "Edit",
	errorClass: "lease-conflict",
	resource: "/repo/file.ts",
	generation: "holder:hash1",
	holder: "holder",
	recovery: "wait for lease release",
};

test("same failure consults holder once on second denial and deduplicates telemetry", () => {
	const db = database();
	expect(recordFailure(db, context, 100)).toContain('"attempts":1');
	expect(recordFailure(db, context, 101)).toContain('"consult":"C1"');
	recordFailure(db, context, 102);
	expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
		n: 1,
	});
	expect(db.query("SELECT kind FROM events ORDER BY ts, rowid").all()).toEqual([
		{ kind: "failure.observed" },
		{ kind: "consult" },
		{ kind: "failure.repeated" },
	]);
});
test("fingerprints change with project, operation and resource generation", () => {
	for (const variant of [
		{ project: "other" },
		{ operation: "Write" },
		{ generation: "hash2" },
	])
		expect(failureFingerprint({ ...context, ...variant })).not.toBe(
			failureFingerprint(context),
		);
});
test("foreign, dead and self holders cannot receive a consult", () => {
	for (const c of [
		{ ...context, project: "other" },
		{ ...context, holder: "asker" },
		{ ...context, holder: "dead" },
	]) {
		const db = database();
		recordFailure(db, c, 100);
		recordFailure(db, c, 101);
		expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
			n: 0,
		});
	}
});
test("resolution and idle window reset an episode without changing its fingerprint", () => {
	const db = database();
	recordFailure(db, context, 100);
	recordFailure(db, context, 101);
	resolveFailures(db, context.project, context.sid, context.resource, 102);
	expect(recordFailure(db, context, 103)).toContain('"attempts":1');
	expect(recordFailure(db, context, 103 + 31 * 60_000)).toContain(
		'"attempts":1',
	);
});
test("at most three open automatic consults per asker", () => {
	const db = database();
	for (let i = 0; i < 5; i++) {
		const c = { ...context, resource: `/file${i}` };
		recordFailure(db, c, 100);
		recordFailure(db, c, 101);
	}
	expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
		n: 3,
	});
});
test("telemetry failure still returns recovery instructions", () => {
	const db = database();
	db.run("DROP TABLE consults");
	expect(recordFailure(db, context, 100)).toContain(
		'"next":"wait for lease release"',
	);
});
