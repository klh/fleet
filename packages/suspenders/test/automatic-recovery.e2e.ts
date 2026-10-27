import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	automaticRecoveryCheck,
	automaticRecoveryPaused,
} from "../hooks/lib/fleet-loop/automatic-recovery.ts";
import { setReclaimHold } from "../hooks/lib/lanes/reclaim-liveness.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
test.afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "fleet-recovery-"));
	dirs.push(repo);
	const db = new Database(":memory:");
	dbs.push(db);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, hb INTEGER NOT NULL, state TEXT NOT NULL)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	db.run("CREATE TABLE decisions (answer_to TEXT, state TEXT)");
	const store = {
		local: true,
		query: (sql: string) => db.query(sql),
		run: (sql: string, ...args: unknown[]) => db.run(sql, ...(args as never[])),
		transaction: <T>(fn: () => T) => db.transaction(fn),
		close: () => db.close(),
	} as GovernorStore;
	const claim = {
		repo,
		store,
		project: "p",
		id: "W1",
		owner: "sid1",
		revision: 1,
	};
	return { repo, db, claim };
}

test("automatic recovery pause protects every claim before death is evaluated", () => {
	const { repo, claim } = fixture();
	mkdirSync(join(repo, ".fleet"));
	writeFileSync(join(repo, ".fleet/reclaim-paused"), "paused\n");
	expect(automaticRecoveryPaused(repo)).toBe(true);
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "paused" });
});

test("missing evidence and a live or unknown claimant remain claimed", () => {
	const { db, claim } = fixture();
	db.run(
		"INSERT INTO sessions VALUES ('sid1', ?, 'RUNNING')",
		Date.now() - 60 * 60_000,
	);
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "unknown" });
	db.run("UPDATE sessions SET hb=? WHERE sid='sid1'", Date.now());
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "alive" });
});

test("an open decision and an explicit wait protect an otherwise dead claimant", () => {
	const { db, claim } = fixture();
	db.run("INSERT INTO decisions VALUES ('sid1','OPEN')");
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "waiting" });
	db.run("DELETE FROM decisions");
	db.run(
		"INSERT INTO sessions VALUES ('sid1', ?, 'WAIT_RATE')",
		Date.now() - 60 * 60_000,
	);
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "waiting" });
});

test("positive session absence permits recovery, but a later heartbeat reverses the verdict", () => {
	const { db, claim } = fixture();
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: true, why: "dead" });
	expect(
		db
			.query("SELECT name FROM sqlite_master WHERE name='lane_launch_intents'")
			.get(),
	).toBeNull();
	db.run("INSERT INTO sessions VALUES ('sid1', ?, 'RUNNING')", Date.now());
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "alive" });
});

test("an explicit reclaim lease protects a positively dead claimant", () => {
	const { claim } = fixture();
	setReclaimHold(
		claim.store,
		claim.project,
		claim.id,
		Date.now() + 60_000,
		claim.owner,
	);
	expect(automaticRecoveryCheck(claim)).toEqual({ ok: false, why: "waiting" });
});
