import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { sqliteStore } from "./store.ts";
import { openHandoffState } from "./handoff-state.ts";

test("handoff claims exclude another HOST and stale completions @unit", () => {
	const db = new Database(":memory:");
	const first = openHandoffState(sqliteStore(db)),
		second = openHandoffState(sqliteStore(db));
	try {
		const op = first.claim("run", "parking", 1);
		expect(() => second.claim("run", "restoring", 1)).toThrow("in progress");
		expect(() => second.fence("run", 1)).toThrow("closed");
		first.finish(op, "parked", 1, '{"id":"sealed"}');
		const restore = second.claim("run", "restoring", 1);
		second.bindEpoch(restore, 3);
		expect(() => first.finish(op, "live", 1)).toThrow("stale");
		expect(() => first.fence("run", 1, restore.id)).toThrow("closed");
		first.fence("run", 3, restore.id, "open");
		expect(() => first.fence("run", 3, restore.id)).toThrow("closed");
		first.activate(restore);
		first.fence("run", 3, restore.id);
		second.finish(restore, "live", 3);
		first.fence("run", 3);
		expect(() => first.fence("run", 1)).toThrow("closed");
	} finally {
		db.close();
	}
});

test("an interrupted persisted phase grants no automatic recovery authority @unit", () => {
	const db = new Database(":memory:"),
		store = sqliteStore(db);
	try {
		openHandoffState(store).claim("run", "recovering", 1);
		const restarted = openHandoffState(store);
		expect(() => restarted.claim("run", "recovering", 1)).toThrow(
			"interrupted",
		);
		expect(() => restarted.fence("run", 1)).toThrow("closed");
	} finally {
		db.close();
	}
});

test("expired operation failure completion retains durable cleanup retry @unit", () => {
	const db = new Database(":memory:"),
		store = sqliteStore(db);
	try {
		const handoffs = openHandoffState(store),
			op = handoffs.claim("run", "parking", 1);
		op.deadlineAt = Date.now() - 1;
		store.run("UPDATE runner_handoffs SET expires_at = 1 WHERE run_id = 'run'");
		expect(() => handoffs.assertOwned(op)).toThrow("lost");
		handoffs.assertOwned(op, true);
		expect(() => handoffs.finish(op, "parked", 1)).toThrow("expired");
		handoffs.finish(op, "failed", 1);
		const retry = handoffs.claim("run", "stopping", 1);
		handoffs.finish(retry, "failed", 1);
		expect(handoffs.read("run")?.op_id).toBeNull();
	} finally {
		db.close();
	}
});
