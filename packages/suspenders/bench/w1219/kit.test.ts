import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	lintSql,
	execSql,
	rowsMatch,
	percentile,
	extractSql,
} from "./kit.ts";
import { buildReplica, SCHEMA_TEXT, type Replica } from "./replica.ts";
import { QUESTIONS } from "./questions.ts";

// W1219 bench kit: pure face + replica builder. The replica is the REAL
// sink schema (real openKnowledgeDb), seeded with a live-shaped corpus.
let rep: Replica;
const root = mkdtempSync(join(tmpdir(), "w1219-kit-"));

describe("w1219 bench kit", () => {
	test("lintSql enforces the ro contract", () => {
		expect(lintSql("SELECT 1").ok).toBe(true);
		expect(lintSql("WITH x AS (SELECT 1) SELECT * FROM x").ok).toBe(true);
		expect(lintSql("DELETE FROM knowledge").ok).toBe(false);
		expect(lintSql("SELECT 1; SELECT 2").ok).toBe(false);
		expect(lintSql("PRAGMA data_version").ok).toBe(false);
		expect(lintSql("").ok).toBe(false);
		expect(lintSql("UPDATE t SET x=1").ok).toBe(false);
	});
	test("extractSql pulls the fenced or bare SQL", () => {
		expect(extractSql("a\n```sql\nSELECT 1\n```\nb")).toBe("SELECT 1");
		expect(extractSql("no sql here")).toBe("");
	});
	test("rowsMatch is order-insensitive and 6dp-stable", () => {
		expect(rowsMatch([{ n: 3 }], [{ n: 3 }])).toBe(true);
		expect(rowsMatch([{ n: 3 }, { n: 4 }], [{ n: 4 }, { n: 3 }])).toBe(true);
		expect(rowsMatch([{ n: 3 }], [{ n: 3.0000001 }])).toBe(true);
		expect(rowsMatch([{ n: 3 }], [{ n: 4 }])).toBe(false);
	});
	test("percentile nearest-rank", () => {
		expect(percentile([1, 2, 3, 4], 50)).toBe(2);
		expect(percentile([1, 2, 3, 4], 95)).toBe(4);
		expect(percentile([], 50)).toBe(0);
	});
	test(
		"replica is the REAL sink schema and every gold SQL runs",
		async () => {
			rep = await buildReplica(root);
			const { Database } = await import("bun:sqlite");
			const ro = new Database(rep.dbPath, { readonly: true });
			const q = (sql: string) => ro.query(sql).all();
			expect(
				q("SELECT name FROM sqlite_master WHERE name='knowledge'").length,
			).toBe(1);
			for (const question of QUESTIONS) {
				const lint = lintSql(question.gold_sql);
				expect(lint.ok, `${question.id} gold lint: ${lint.why}`).toBe(true);
				const gold = q(question.gold_sql);
				expect(Array.isArray(gold), `${question.id} gold runs`).toBe(true);
			}
			expect(
				QUESTIONS.filter((x) => x.lang === "da").length,
			).toBeGreaterThanOrEqual(3);
				ro.close();
		},
		20_000,
	);
	test("execSql on the replica matches gold by construction", async () => {
		if (!rep) rep = await buildReplica(root);
		const { Database } = await import("bun:sqlite");
		const ro = new Database(rep.dbPath, { readonly: true });
		const gold = QUESTIONS.find((x) => x.id === "Q01");
		expect(gold).toBeDefined();
		const g = gold ? execSql(ro, gold.gold_sql) : undefined;
		expect(g?.ok).toBe(true);
		if (g?.ok) expect(rowsMatch(g.rows, [{ "COUNT(*)": 3 }])).toBe(true);
		ro.close();
	});
	afterAll(() => {
		if (rep) rep.close();
	});
});
