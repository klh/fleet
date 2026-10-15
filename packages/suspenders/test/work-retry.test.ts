import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import { retryFailedItem } from "../hooks/lib/work-retry.ts";
import { launchSchema } from "../scripts/lib/launch-fencing.ts";

function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"INSERT INTO work_items VALUES ('project','W1','FAILED','lane','s',100)",
	);
	db.run("INSERT INTO claims VALUES ('lane','s','W1 anything')");
	launchSchema(db as unknown as GovernorStore);
	return db as unknown as GovernorStore;
}

test("FAILED → READY, stale claim released, launch budget reset", () => {
	const store = fixture();
	store.run("INSERT INTO lane_launch_budgets VALUES ('project','W1',3)");
	const r = retryFailedItem(store, "project", "W1");
	expect(r.ok).toBe(true);
	const it = store
		.query("SELECT state, owner_sid FROM work_items WHERE id='W1'")
		.get() as { state: string; owner_sid: string | null };
	expect(it.state).toBe("READY");
	expect(it.owner_sid).toBeNull();
	expect(
		store.query("SELECT COUNT(*) c FROM lane_launch_budgets").get(),
	).toEqual({ c: 0 });
	expect(store.query("SELECT COUNT(*) c FROM claims").get()).toEqual({ c: 0 });
});

test("non-FAILED and missing items are refused", () => {
	const store = fixture();
	store.run("UPDATE work_items SET state='DONE' WHERE id='W1'");
	const r = retryFailedItem(store, "project", "W1");
	expect(r.ok).toBe(false);
	expect(r.error).toContain("only FAILED items retry");
	expect(retryFailedItem(store, "project", "W9").error).toContain(
		"no such work item",
	);
});
