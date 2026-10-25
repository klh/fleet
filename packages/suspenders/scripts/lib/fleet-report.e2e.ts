// fleet-report.test.ts — W899: the shared render (renderFleetReport) emits
// the W892 table from a seeded store, and composeBrief carries it as the
// FLEET REPORT section — the same shape the install tail and session-start
// SUPERVISOR DEFAULT emit.
import { test, expect } from "@playwright/test";
import { Database } from "bun:sqlite";
import { renderFleetReport } from "./fleet-report.ts";
import { composeBrief } from "./brief.ts";

const PROJECT = "w899-test-project";

const seedDb = (): Database => {
	const db = new Database(":memory:");
	db.run(
		`CREATE TABLE work_items (
			project TEXT NOT NULL, id TEXT NOT NULL, title TEXT, state TEXT,
			priority INTEGER, required TEXT, created_at INTEGER, updated_at INTEGER,
			PRIMARY KEY (project, id)
		)`,
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
	);
	db.run(
		"INSERT INTO work_items (project, id, title, state, priority, required, created_at, updated_at) VALUES (?, 'W1', 'seed riding item', 'CLAIMED', 0, 1, ?, ?)",
		[PROJECT, Date.now(), Date.now()],
	);
	return db;
};

test.describe("renderFleetReport (W899)", () => {
	test("renders the W892 table from a seeded store", () => {
		const db = seedDb();
		const table = renderFleetReport(db, PROJECT);
		expect(table).toContain("ITEM");
		expect(table).toContain("W1");
		expect(table).toContain("seed riding item");
		db.close();
	});
});

test.describe("composeBrief fleetReport section (W899)", () => {
	test("carries the table as the FLEET REPORT section", () => {
		const brief = composeBrief({
			item: "W899",
			showOut: "do the thing",
			sid: "autow899-test",
			branch: "suspenders/W899",
			worktree: "/tmp/wt",
			capsule: null,
			fleetReport: "ITEM  ST  TASK\n----  --  ----",
		});
		expect(brief).toContain("FLEET REPORT:");
		expect(brief).toContain("ITEM  ST  TASK");
	});

	test("no fleetReport — no section", () => {
		const brief = composeBrief({
			item: "W899",
			showOut: "do the thing",
			sid: "autow899-test",
			branch: "suspenders/W899",
			worktree: "/tmp/wt",
			capsule: null,
		});
		expect(brief).not.toContain("FLEET REPORT:");
	});
});
