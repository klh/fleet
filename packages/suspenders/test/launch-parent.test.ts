import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { launchParent } from "../scripts/lib/launch-parent.ts";

test("launch parent requires durable creator provenance in the same live project", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE work_items(project TEXT,id TEXT,created_by TEXT); CREATE TABLE sessions(sid TEXT,project TEXT,state TEXT,hb INTEGER)",
		);
		db.query("INSERT INTO work_items VALUES (?,?,?)").run(
			"project",
			"W1",
			"mother",
		);
		db.query("INSERT INTO sessions VALUES (?,?,?,?)").run(
			"mother",
			"project",
			"RUNNING",
			1000000,
		);
		expect(launchParent(db, "project", "W1", 1000000)).toBe("mother");
		expect(launchParent(db, "other", "W1", 1000000)).toBeNull();
		expect(launchParent(db, "project", "W1", 2000000)).toBeNull();
		db.query("UPDATE sessions SET state='CLOSED'").run();
		expect(launchParent(db, "project", "W1", 1000000)).toBeNull();
		db.query("UPDATE sessions SET state='RUNNING',project='foreign'").run();
		expect(launchParent(db, "project", "W1", 1000000)).toBeNull();
		db.query("UPDATE work_items SET created_by='unknown'").run();
		expect(launchParent(db, "project", "W1", 1000000)).toBeNull();
	} finally {
		db.close();
	}
});
