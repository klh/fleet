// test/budget-flag.test.ts — W782.4: the one-open-budget-NEED_DECISION
// throttle: claim/get/clear round-trip on a scratch governor store. The flag
// fact is keyed per item, shared by the launch- and resume-budget emitters,
// and drained by work retry / work done.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	budgetFlagClaim,
	budgetFlagClear,
	budgetFlagGet,
	budgetFlagKey,
} from "../hooks/lib/budget-flag.ts";

function fixture(): GovernorStore {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	return db as unknown as GovernorStore;
}

test("key format is the W787 fact key", () => {
	expect(budgetFlagKey("W123")).toBe("lane.budget-flagged.W123");
});

test("claim once → emit; again → suppress; clear → emit again", () => {
	const store = fixture();
	expect(budgetFlagClaim(store, "W1")).toBe(true);
	expect(budgetFlagClaim(store, "W1")).toBe(false);
	const stamp = budgetFlagGet(store, "W1");
	expect(stamp).toBeTruthy();
	expect(Number.isNaN(Date.parse(stamp as string))).toBe(false);
	budgetFlagClear(store, "W1");
	expect(budgetFlagGet(store, "W1")).toBeUndefined();
	expect(budgetFlagClaim(store, "W1")).toBe(true);
});

test("flags are per-item", () => {
	const store = fixture();
	expect(budgetFlagClaim(store, "W2")).toBe(true);
	expect(budgetFlagClaim(store, "W3")).toBe(true);
	expect(budgetFlagGet(store, "W2")).toBeTruthy();
	expect(budgetFlagGet(store, "W3")).toBeTruthy();
	budgetFlagClear(store, "W2");
	expect(budgetFlagGet(store, "W2")).toBeUndefined();
	expect(budgetFlagGet(store, "W3")).toBeTruthy();
});
