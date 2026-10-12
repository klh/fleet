// test/gov-audit-chain.test.ts — W703: auth_events hash chain detects an
// edited / removed / reordered row; retention-pruned prefix stays valid.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GENESIS, verifyAuthChain } from "../src/gov/audit-chain.ts";
import { KeyStore } from "../src/gov/keys.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";

function seeded(n = 5): { db: Database; ks: KeyStore } {
	const db = new Database(":memory:", { create: true });
	applyGovernanceSchema(db);
	const ks = new KeyStore(db);
	for (let i = 0; i < n; i++)
		ks.recordAuthEvent(`actor${i}`, "issued", `j${i}`, "api_key");
	return { db, ks };
}

describe("auth_events hash chain (W703)", () => {
	test("clean chain verifies, genesis-anchored", () => {
		const { db } = seeded();
		const v = verifyAuthChain(db);
		expect(v.ok).toBe(true);
		expect(v.rows).toBe(5);
		expect(v.legacy).toBe(0);
		expect(v.anchored).toBe(false);
		const first = db
			.query("SELECT prev_hash FROM auth_events WHERE id=1")
			.get();
		expect(first).toEqual({ prev_hash: GENESIS });
	});

	test("edited row is detected", () => {
		const { db } = seeded();
		db.run("UPDATE auth_events SET actor = 'mallory' WHERE id = 3");
		const v = verifyAuthChain(db);
		expect(v.ok).toBe(false);
		expect(v.broken?.id).toBe(3);
		expect(v.broken?.reason).toContain("edited");
	});

	test("removed interior row is detected", () => {
		const { db } = seeded();
		db.run("DELETE FROM auth_events WHERE id = 3");
		const v = verifyAuthChain(db);
		expect(v.ok).toBe(false);
		expect(v.broken?.id).toBe(4);
		expect(v.broken?.reason).toContain("removed");
	});

	test("removed tail needs the pinned head; with it, detected", () => {
		const { db } = seeded();
		const head = verifyAuthChain(db).head ?? "";
		db.run("DELETE FROM auth_events WHERE id = 5");
		expect(verifyAuthChain(db).ok).toBe(true);
		const v = verifyAuthChain(db, { expectHead: head });
		expect(v.ok).toBe(false);
		expect(v.broken?.reason).toContain("head mismatch");
	});

	test("stripped hashes mid-chain are detected", () => {
		const { db } = seeded();
		db.run(
			"UPDATE auth_events SET prev_hash = NULL, row_hash = NULL WHERE id = 4",
		);
		expect(verifyAuthChain(db).ok).toBe(false);
	});

	test("retention-pruned prefix re-anchors, still valid", () => {
		const { db } = seeded();
		db.run("DELETE FROM auth_events WHERE id <= 2");
		const v = verifyAuthChain(db);
		expect(v.ok).toBe(true);
		expect(v.anchored).toBe(true);
		expect(v.rows).toBe(3);
	});

	test("pre-chain legacy rows are counted, new rows chain from genesis", () => {
		const db = new Database(":memory:", { create: true });
		db.run(
			"CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, event TEXT NOT NULL, jti TEXT, via TEXT)",
		);
		db.run(
			"INSERT INTO auth_events (ts, actor, event) VALUES (1, 'old', 'issued')",
		);
		applyGovernanceSchema(db);
		new KeyStore(db).recordAuthEvent("new", "revoked", null, "api_key");
		const v = verifyAuthChain(db);
		expect(v.ok).toBe(true);
		expect(v.legacy).toBe(1);
		expect(v.rows).toBe(2);
	});
});
