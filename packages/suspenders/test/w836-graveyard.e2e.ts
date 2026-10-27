// test/w836-graveyard.test.ts — W836 audit trust schema + graveyard-with-reason:
// the knowledge.db guarded ALTERs heal live files (rating/evidence/researched_at/
// graveyard_reason), store grade/graveyard round-trip, and recall ranking
// excludes buried rows. Isolated temp HOME + query-bust import (w208 recipe).
import { expect, test } from "./pw";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w836-"));
// restore before test.afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb, openKnowledgeDb } = await import(
	`../hooks/lib/govdb/govdb.ts?w836=${encodeURIComponent(HOME)}`
);

mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

test.afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

function freshKb(): Database {
	return openGovernorDb() && openKnowledgeDb();
}

function seed(topic: string): number {
	const db = openKnowledgeDb();
	const r = db
		.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, updated_at) VALUES (?, ?, 'fact text', 0.8, 'active', ?)",
		)
		.run(Date.now(), topic, Date.now());
	return Number(r.lastInsertRowid);
}

function row(id: number):
	| {
			state: string;
			rating: string | null;
			evidence: string | null;
			researched_at: number | null;
			graveyard_reason: string | null;
	  }
	| undefined {
	return openKnowledgeDb()
		.query(
			"SELECT state, rating, evidence, researched_at, graveyard_reason FROM knowledge WHERE id = ?",
		)
		.get(id) as
		| {
				state: string;
				rating: string | null;
				evidence: string | null;
				researched_at: number | null;
				graveyard_reason: string | null;
		  }
		| undefined;
}

let SqliteKnowledgeStore: new (
	db: Database,
) => import("../hooks/lib/knowledge/sqlite-store.ts").SqliteKnowledgeStore;
let knowledgeSearch: typeof import("../hooks/lib/knowledge/knowledge.ts").knowledgeSearch;

test("boot: trust columns heal on open", () => {
	const kb = freshKb();
	const cols = (
		kb.query("PRAGMA table_info(knowledge)").all() as { name: string }[]
	).map((c) => c.name);
	for (const c of ["rating", "evidence", "researched_at", "graveyard_reason"])
		expect(cols).toContain(c);
});

test("boot2: store + search imports", async () => {
	({ SqliteKnowledgeStore } = await import(
		"../hooks/lib/knowledge/sqlite-store.ts"
	));
	({ knowledgeSearch } = await import("../hooks/lib/knowledge/knowledge.ts"));
});

test("grade stamps rating/evidence/researched_at + provenance note", async () => {
	const kb = freshKb();
	const store = new SqliteKnowledgeStore(kb);
	const id = seed("grade me");
	expect(
		await store.grade(id, {
			rating: "solid",
			evidence: "docs/a.md:4",
			researchedAt: 1_700_000_000_000,
		}),
	).toBe(true);
	const r = row(id);
	expect(r?.rating).toBe("solid");
	expect(r?.evidence).toBe("docs/a.md:4");
	expect(r?.researched_at).toBe(1_700_000_000_000);
	// absent fields keep current values (COALESCE contract)
	expect(await store.grade(id, { rating: "suspect" })).toBe(true);
	const r2 = row(id);
	expect(r2?.rating).toBe("suspect");
	expect(r2?.evidence).toBe("docs/a.md:4");
	const db = openKnowledgeDb();
	const note = (
		db.query("SELECT contributors FROM knowledge WHERE id = ?").get(id) as {
			contributors: string;
		}
	).contributors;
	expect(note).toContain("grade:");
});

test("graveyard buries with reason, never deletes, refuses twice", async () => {
	const kb = freshKb();
	const store = new SqliteKnowledgeStore(kb);
	const id = seed("bury me");
	expect(
		await store.graveyard(
			id,
			"suspected star manipulation - fork/star curve inconsistent",
		),
	).toBe(true);
	const r = row(id);
	expect(r?.state).toBe("graveyard");
	expect(r?.graveyard_reason).toContain("star manipulation");
	// the row still EXISTS (never deleted)
	expect(
		kb.query("SELECT COUNT(*) AS n FROM knowledge WHERE id = ?").get(id),
	).toBeDefined();
	// double burial refuses
	expect(await store.graveyard(id, "again")).toBe(false);
	// grade refuses on graveyarded rows
	expect(await store.grade(id, { rating: "x" })).toBe(false);
});

test("recall ranking excludes graveyard rows", async () => {
	const kb = freshKb();
	const store = new SqliteKnowledgeStore(kb);
	const buried = seed("gravestar quuxword");
	await store.graveyard(buried, "integrity-flagged");
	const live = seed("gravestar quuxword live");
	expect(live).toBeGreaterThan(0);
	const hits = knowledgeSearch(kb, "gravestar quuxword");
	const ids = hits.filter((h) => h.kind === "knowledge").map((h) => h.id);
	expect(ids).not.toContain(buried);
	expect(ids).toContain(live);
});

test("coord fact set/get output carries the schema note (spawn smoke)", () => {
	const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const run = (args: string[]): string => {
		const p = Bun.spawnSync(["bun", COORD, ...args], {
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		return new TextDecoder().decode(p.stdout);
	};
	run(["fact", "set", "w836.demo", "plain"]);
	const s = run(["fact", "set", "w836.demo", "again"]);
	const g = run(["fact", "get", "w836.demo"]);
	expect(s).toContain("schema note:");
	expect(g).toContain("schema note:");
	expect(g).toContain("again");
});
