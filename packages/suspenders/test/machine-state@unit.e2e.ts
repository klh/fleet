// machine-state@unit.e2e.ts — hub design D3: telemetry prefixes leave
// facts (FTS + deltas audit) for machine_state. Proves: the open-time
// migration moves harvest./metrics./deadletter./executor. rows and keeps
// control/knowledge rows (lane.*, lesson.*) in facts; it is idempotent; an
// unchanged msSet writes nothing (no deltas row, ts unchanged).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-ms-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const ms = await import("../hooks/lib/govdb/machine-state.ts");
process.env.HOME = REAL_HOME;

test.afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("migration moves telemetry prefixes, keeps control + knowledge rows", () => {
	const db = govdb.openGovernorDb();
	const put = db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 't', 1, ?)",
	);
	for (const k of [
		"harvest.cursor.a",
		"harvest.seen.b",
		"metrics.tokens.p.W1",
		"deadletter.42",
		"executor.host.claude.cv",
		"lane.s1.state",
		"lesson.keep-me",
	])
		put.run(k, "v", 1);
	expect(ms.migrateMachineState(db)).toBe(5);
	const facts = db.query("SELECT key FROM facts ORDER BY key").all();
	expect(facts.map((r) => r.key)).toEqual(["lane.s1.state", "lesson.keep-me"]);
	expect(ms.msList(db, "harvest.").map((r) => r.key)).toEqual([
		"harvest.cursor.a",
		"harvest.seen.b",
	]);
	expect(ms.msGet(db, "executor.host.claude.cv")).toBe("v");
	expect(ms.migrateMachineState(db)).toBe(0);
});

test("msSet: unchanged value is a no-op, changed value updates", () => {
	const db = govdb.openGovernorDb();
	ms.msSet(db, "harvest.cursor.z", "10", "harvest", 100);
	ms.msSet(db, "harvest.cursor.z", "10", "harvest", 200);
	const row = () =>
		db
			.query("SELECT value, ts FROM machine_state WHERE key = ?")
			.get("harvest.cursor.z");
	expect(row()).toEqual({ value: "10", ts: 100 });
	ms.msSet(db, "harvest.cursor.z", "11", "harvest", 300);
	expect(row()).toEqual({ value: "11", ts: 300 });
	const deltas = db
		.query("SELECT COUNT(*) AS n FROM deltas WHERE pk = 'harvest.cursor.z'")
		.get();
	expect(deltas.n).toBe(0);
});
