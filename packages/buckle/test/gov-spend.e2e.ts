// test/gov-spend.test.ts — W843 bounded spend policy: the team spend
// ceiling rides the same BEGIN IMMEDIATE admission transaction (replica-
// safe like the W468 books), the input estimate is reserved at admission,
// real usage lands at settle, and the book errs high (estimate + real),
// never under. Currency limits stay evidence-gated — this bounds TOKENS.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { Budgets } from "../src/gov/budgets.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";

test.describe({ tag: "@unit" }, () => {
	function fileDb(): Database {
		const path = `/tmp/w843-spend-${Date.now()}-${process.pid}-${Math.random()
			.toString(36)
			.slice(2, 8)}.db`;
		const db = new Database(path, { create: true });
		db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(db);
		return db;
	}

	const spendTeam = (spend: number | null) => ({
		id: "ops",
		limits: { rpm: null, tpm: null, spend },
	});

	test.describe("W843 bounded team spend", () => {
		test("admission reserves the input estimate; strictly-over denies", () => {
			const db = fileDb();
			const b = new Budgets(db);
			// est = ceil(200/4) = 50 per admission against a 100-token ceiling
			expect(
				b.check("k1", { rpm: null, tpm: null }, 200, spendTeam(100)).ok,
			).toBe(true);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 200, spendTeam(100)).ok,
			).toBe(true);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 200, spendTeam(100)).ok,
			).toBe(false);
		});

		test("denial rolls the spend reservation back — no residue", () => {
			const db = fileDb();
			const b = new Budgets(db);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 400, spendTeam(100)).ok,
			).toBe(true);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 400, spendTeam(100)).ok,
			).toBe(false);
			const row = db
				.query("SELECT used_tok FROM spend_state WHERE subject = 'team:ops'")
				.get() as { used_tok: number };
			expect(row.used_tok).toBe(100);
		});

		test("settle adds the real usage — the book errs high, never under", () => {
			const db = fileDb();
			const b = new Budgets(db);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 200, spendTeam(1000)).ok,
			).toBe(true);
			b.addUsage("k1", 1, 300, 0, 0, { id: "ops" });
			const sp = b.snapshotSpends().find((s) => s.subject === "team:ops");
			expect(sp?.usedTok).toBe(350); // 50 estimate + 300 real
		});

		test("no spend ceiling → never reserved or denied, but real usage books", () => {
			const db = fileDb();
			const b = new Budgets(db);
			expect(
				b.check("k1", { rpm: null, tpm: null }, 200, spendTeam(null)).ok,
			).toBe(true);
			b.addUsage("k1", 1, 500, 0, 0, { id: "ops" });
			// no reservation landed at admission (50 never booked); settle books
			// the real usage so the per-team report stays readable for uncapped
			// teams too
			const sp = b.snapshotSpends().find((s) => s.subject === "team:ops");
			expect(sp?.usedTok).toBe(500);
		});

		test("books are written even when the window limits are unbounded", () => {
			// the middleware skip (null rpm/tpm) must not strand the spend book —
			// the Budgets.check path itself reserves whenever a ceiling exists
			const db = fileDb();
			const b = new Budgets(db);
			const v = b.check("k1", { rpm: null, tpm: null }, 40, spendTeam(1));
			expect(v.ok).toBe(false); // est 10 > 1 ceiling
		});

		test("fail-closed: an unavailable budget authority throws, never passes", () => {
			const db = fileDb();
			const b = new Budgets(db);
			db.close(); // the authority is gone
			expect(() =>
				b.check("k1", { rpm: null, tpm: null }, 40, spendTeam(100)),
			).toThrow();
		});
	});
});
