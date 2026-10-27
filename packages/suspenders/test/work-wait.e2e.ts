import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	parseWaitUntil,
	waitForPrerequisite,
	wakeAfterEvidence,
} from "../hooks/lib/work/work-wait.ts";

function fixture(): GovernorStore {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, wait_kind TEXT, wait_reason TEXT, wait_until INTEGER, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	db.run(
		"INSERT INTO work_items VALUES ('p','W1','FAILED','stale','scope',NULL,NULL,NULL,1)",
	);
	db.run("INSERT INTO claims VALUES ('stale','scope','W1 work')");
	return db as unknown as GovernorStore;
}

test("failed external prerequisite waits without losing failure evidence and is excluded from ready", () => {
	const db = fixture();
	const until = parseWaitUntil("2026-11-01T00:00:00Z");
	expect(
		waitForPrerequisite(db, "p", "W1", "quota", "seat reset", until).ok,
	).toBe(true);
	expect(
		db
			.query(
				"SELECT state, owner_sid, wait_kind, wait_reason, wait_until FROM work_items WHERE id='W1'",
			)
			.get(),
	).toEqual({
		state: "WAITING",
		owner_sid: null,
		wait_kind: "quota",
		wait_reason: "seat reset",
		wait_until: until,
	});
	expect(db.query("SELECT COUNT(*) n FROM claims").get()).toEqual({ n: 0 });
	expect(
		db.query("SELECT COUNT(*) n FROM work_items WHERE state='READY'").get(),
	).toEqual({ n: 0 });
	expect(wakeAfterEvidence(db, "p", "W1", "seat verified").ok).toBe(false);
	expect(wakeAfterEvidence(db, "p", "W1", "seat verified", true).ok).toBe(true);
	expect(
		db
			.query(
				"SELECT state, wait_kind, wait_reason, wait_until FROM work_items WHERE id='W1'",
			)
			.get(),
	).toEqual({
		state: "READY",
		wait_kind: null,
		wait_reason: null,
		wait_until: null,
	});
});

test("wait refuses active and terminal work, invalid kinds, and empty reasons", () => {
	const db = fixture();
	db.run("UPDATE work_items SET state='RUNNING' WHERE id='W1'");
	expect(
		waitForPrerequisite(db, "p", "W1", "quota", "reset", null).error,
	).toContain("release an active claim");
	db.run("UPDATE work_items SET state='DONE' WHERE id='W1'");
	expect(waitForPrerequisite(db, "p", "W1", "quota", "reset", null).ok).toBe(
		false,
	);
	expect(waitForPrerequisite(db, "p", "W1", "mystery", "reset", null).ok).toBe(
		false,
	);
	expect(waitForPrerequisite(db, "p", "W1", "quota", " ", null).ok).toBe(false);
	expect(() => parseWaitUntil("tomorrow")).toThrow();
});
