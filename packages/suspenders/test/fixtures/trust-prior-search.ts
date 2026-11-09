// test/fixtures/trust-prior-search.ts — the FTS-backed knowledge search
// fixture for the W2846 trust-prior spec (the knowledge.test.ts W245 stage
// shape, extracted): knowledgeSearch rides knowledge_fts, which the distill
// world does not create.
import { Database } from "bun:sqlite";

const KSCHEMA = `CREATE TABLE knowledge (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	topic TEXT NOT NULL,
	fact TEXT NOT NULL,
	confidence REAL,
	domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT,
	source_ref TEXT, state TEXT NOT NULL DEFAULT 'candidate', updated_at INTEGER)`;

const FSCHEMA = `CREATE VIRTUAL TABLE knowledge_fts USING fts5(
	topic, fact, domain UNINDEXED, area UNINDEXED,
	origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED,
	content='knowledge', content_rowid='id')`;

export const searchDb = (): Database => {
	const db = new Database(":memory:");
	db.exec(`${KSCHEMA}; ${FSCHEMA}`);
	return db;
};

/** Seed one row + its FTS index row; returns the knowledge id. */
export const seedRow = (
	db: Database,
	row: { topic: string; fact: string; originKind: string; state: string },
): number => {
	const id = Number(
		db
			.query(
				`INSERT INTO knowledge (ts, topic, fact, origin_kind, state, updated_at)
					VALUES (1, ?, ?, ?, ?, 1)`,
			)
			.run(row.topic, row.fact, row.originKind, row.state).lastInsertRowid,
	);
	db.query(
		`INSERT INTO knowledge_fts (rowid, topic, fact, origin_kind, state)
			VALUES (?, ?, ?, ?, ?)`,
	).run(id, row.topic, row.fact, row.originKind, row.state);
	return id;
};
