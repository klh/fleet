import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { orchRecipient, orchTargets } from "../hooks/board/orch-targets.ts";

test.describe("orchestrator work-item recipients", () => {
	test("resolves only within the pinned project and keeps missing targets unavailable", () => {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, owner_sid TEXT, parent_id TEXT)",
		);
		db.run("CREATE TABLE facts (key TEXT, value TEXT)");
		db.query("INSERT INTO work_items VALUES (?, ?, ?, ?)").run(
			"fleet",
			"W1",
			"parent-lane",
			null,
		);
		db.query("INSERT INTO work_items VALUES (?, ?, ?, ?)").run(
			"fleet",
			"W1.1",
			"child-lane",
			"W1",
		);
		db.query("INSERT INTO work_items VALUES (?, ?, ?, ?)").run(
			"other",
			"W1.1",
			"wrong-lane",
			null,
		);
		db.query("INSERT INTO facts VALUES (?, ?)").run(
			"coordinator.sid",
			"supervisor-lane",
		);
		const targets = orchTargets(db, "fleet", "W1.1");
		expect(targets).toEqual({
			id: "W1.1",
			project: "fleet",
			parentId: "W1",
			lane: "child-lane",
			parent: "parent-lane",
			supervisor: "supervisor-lane",
		});
		expect(
			orchRecipient(targets as NonNullable<typeof targets>, "parent"),
		).toBe("parent-lane");
		expect(orchTargets(db, "fleet", "W404")).toBeNull();
		expect(orchTargets(db, "other", "W1.1")?.parent).toBeNull();
		db.close();
	});
});
