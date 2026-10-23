// hooks/lib/govdb-knowledge.ts — the knowledge workload's schema home:
// the v10 governor.db→knowledge.db split, the v6/W91 knowledge-layer
// migration, and openKnowledgeDb (read-path pragmas for the FTS5 hot
// path). W624 split — consumers import govdb.ts, never this file.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { columnNames, openWALDb, REG } from "./govdb-util.ts";
import {
	CONFIDENCE_HISTORY_DDL,
	CONFIDENCE_HISTORY_INDEX_DDL,
} from "./confidence.ts";

// The knowledge FTS shape in its three historical variants (v6 fresh create,
// v10 kb.-qualified split, W91 external-content convergence): one builder so
// the SQL can never drift between the copies. The kb. prefix lands on the
// object names; trigger bodies and the ON table stay unqualified — SQLite
// forbids cross-db references inside a trigger (see migrateKnowledgeSplit).
const knowledgeFtsDdl = (
	prefix: string,
	ifNotExists: boolean,
): { table: string; triggers: string[] } => {
	const ine = ifNotExists ? "IF NOT EXISTS " : "";
	return {
		table: `CREATE VIRTUAL TABLE ${ine}${prefix}knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')`,
		triggers: [
			`CREATE TRIGGER ${ine}${prefix}knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END`,
			`CREATE TRIGGER ${ine}${prefix}knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END`,
			`CREATE TRIGGER ${ine}${prefix}knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END`,
		],
	};
};

/** Heal legacy regular or kb-qualified FTS tables after the knowledge split. */
function repairKnowledgeFts(db: Database): void {
	const current = db
		.query(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'",
		)
		.get() as { sql?: string } | null;
	if (!current?.sql || current.sql.includes("content='knowledge'")) return;
	db.transaction(() => {
		for (const name of [
			"knowledge_fts_ai",
			"knowledge_fts_ad",
			"knowledge_fts_au",
		])
			db.run(`DROP TRIGGER IF EXISTS ${name}`);
		db.run("DROP TABLE knowledge_fts");
		const ddl = knowledgeFtsDdl("", false);
		db.run(ddl.table);
		db.run("INSERT INTO knowledge_fts (knowledge_fts) VALUES ('rebuild')");
		for (const trigger of ddl.triggers) db.run(trigger);
	})();
}

// v10 statement list (W166): the knowledge split rides ONE transaction, so
// the whole move is a fixed, reviewable statement table — kb side (CREATE +
// copy preserving ids + FTS rebuild from main), then main side (DROP).
// Trigger bodies may NOT schema-qualify (SQLite forbids cross-db references
// inside a trigger) — the kb.name prefix registers the trigger in kb, where
// the unqualified body/ON names resolve.
// kb pre-existing (rolled-back attempt = empty file; RESET governor meeting
// the post-split store = kb final + rows) must not break the move: DDL is
// IF NOT EXISTS and the row copies ride ONLY into an empty kb (kb wins on
// reset); split-brain (both sides hold rows) refuses loudly in the fn below.
const KNOWLEDGE_SPLIT_V10 = (copy: boolean): string[] => {
	const fts = knowledgeFtsDdl("kb.", true);
	return [
		"CREATE TABLE IF NOT EXISTS kb.knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER)",
		fts.table,
		...fts.triggers,
		"CREATE TABLE IF NOT EXISTS kb.knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result_key TEXT, domain TEXT, area TEXT, code_origin TEXT, started_at INTEGER, origin_sid TEXT, source_ref TEXT, source_hash TEXT, hub_eligible INTEGER)",
		...(copy
			? [
					"INSERT INTO kb.knowledge (id, ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, superseded_by, created_at, updated_at, hub_eligible) SELECT id, ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, superseded_by, created_at, updated_at, hub_eligible FROM main.knowledge ORDER BY id",
					"INSERT INTO kb.knowledge_queue (id, ts, source, payload, state, attempts, result_key, domain, area, code_origin, started_at, origin_sid, source_ref, source_hash, hub_eligible) SELECT id, ts, source, payload, state, attempts, result_key, domain, area, code_origin, started_at, origin_sid, source_ref, source_hash, hub_eligible FROM main.knowledge_queue ORDER BY id",
					"INSERT INTO kb.knowledge_fts (rowid, topic, fact) SELECT id, topic, fact FROM main.knowledge",
				]
			: []),
		"DROP TRIGGER IF EXISTS main.knowledge_fts_ai",
		"DROP TRIGGER IF EXISTS main.knowledge_fts_ad",
		"DROP TRIGGER IF EXISTS main.knowledge_fts_au",
		"DROP TABLE IF EXISTS main.knowledge_fts",
		"DROP TABLE IF EXISTS main.knowledge",
		"DROP TABLE IF EXISTS main.knowledge_queue",
	];
};

// W166: the v6-era knowledge tables leave governor.db (uv < 10) — one
// transaction across main + attached kb; a crash rolls back, uv stays < 10,
// and the next open retries. The pre-migration VACUUM INTO of governor.db
// (knowledge rows still resident) is the rollback anchor.
export function migrateKnowledgeSplit(db: Database): void {
	db.run("ATTACH DATABASE ? AS kb", [`${REG()}/knowledge.db`]);
	const n = (s: string): number =>
		Number((db.query(s).get() as { n: number }).n);
	const mainN = n("SELECT COUNT(*) AS n FROM main.knowledge");
	const kbHas =
		n("SELECT COUNT(*) AS n FROM kb.sqlite_master WHERE name = 'knowledge'") >
		0;
	const kbN = kbHas ? n("SELECT COUNT(*) AS n FROM kb.knowledge") : 0;
	// split-brain refusal: both files holding knowledge rows is not a state a
	// migration may guess its way out of — name the pre-split backups instead.
	if (kbHas && kbN > 0 && mainN > 0)
		throw new Error(
			"knowledge split (v10): governor.db AND knowledge.db both hold knowledge rows — resolve manually (pre-split snapshots: governor-pre-knowledge-split-*)",
		);
	if (mainN > 0) {
		let bak = `${REG()}/governor-pre-knowledge-split-${Date.now()}.db`;
		for (let i = 1; existsSync(bak); i++)
			bak = `${REG()}/governor-pre-knowledge-split-${Date.now()}-${i}.db`;
		db.run(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
		console.error(
			`[govdb] v10 pre-migration backup: ${bak} (${mainN} knowledge rows)`,
		);
	}
	// page_size bakes at file creation — set BEFORE the first kb write; a
	// no-op when kb already has pages (retry after a rolled-back attempt).
	db.run("PRAGMA kb.page_size = 8192");
	db.run("BEGIN IMMEDIATE");
	try {
		for (const sql of KNOWLEDGE_SPLIT_V10(kbN === 0)) db.run(sql);
		db.run("PRAGMA user_version = 10");
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(
					`govdb knowledge split (v10) failed, rolled back: ${e.message}`,
					{
						cause: e,
					},
				)
			: e;
	}
	db.run("VACUUM"); // freed pages returned (design step 5, outside the tx)
	db.run("DETACH DATABASE kb");
}

export function migrateKnowledgeLayer(db: Database, uv: number): void {
	// v6 — the knowledge layer (W91): distilled fleet knowledge as first-class
	// rows with the sortable axes (domain/area/origin_kind/origin_system/
	// code_origin) the plan→query→investigate workflow needs; state gates
	// promotion (worker writes candidates, human/merge promotes). DDL +
	// facts backfill in ONE transaction — a crash rolls back, next open retries.
	if (uv < 6) {
		db.run("BEGIN IMMEDIATE");
		try {
			db.run(
				"CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER)",
			);
			// external-content FTS5 (W91 #7): the index holds ONLY the inverted
			// index — topic+fact text is read from knowledge at query time, so
			// text is stored exactly once. UNINDEXED filter columns fall through
			// to the content table by name (hence origin_kind, not kind).
			const ddl = knowledgeFtsDdl("", true);
			for (const sql of [ddl.table, ...ddl.triggers]) db.run(sql);
			db.run(
				"CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(value, key UNINDEXED)",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN DELETE FROM facts_fts WHERE rowid = OLD.rowid; END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN DELETE FROM facts_fts WHERE rowid = OLD.rowid; INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result_key TEXT, domain TEXT, area TEXT, code_origin TEXT, started_at INTEGER, origin_sid TEXT, source_ref TEXT, source_hash TEXT)",
			);
			db.run(
				"INSERT INTO facts_fts (rowid, value, key) SELECT rowid, value, key FROM facts WHERE value IS NOT NULL",
			);
			db.run("PRAGMA user_version = 6");
			db.run("COMMIT");
		} catch (e) {
			try {
				db.run("ROLLBACK");
			} catch {}
			throw e instanceof Error
				? new Error(
						`govdb knowledge-layer migration (v6) failed, rolled back: ${e.message}`,
						{ cause: e },
					)
				: e;
		}
	}
	// W91 schema-delta convergence (every open, idempotent): DBs that already
	// ran the first v6 draft pre-date the full knowledge shape — converge the
	// columns + backfill the ms clocks at every open, never silently drift.
	const knCols = columnNames(db, "knowledge");
	if (knCols.length) {
		const adds: [string, string][] = [
			["created_at", "INTEGER"],
			["updated_at", "INTEGER"],
			["origin_sid", "TEXT"],
			["contributors", "TEXT"],
			["duplicate_of", "INTEGER"],
			["supersedes_id", "INTEGER"],
			["source_ref", "TEXT"],
			["source_hash", "TEXT"],
		];
		for (const [col, ddl] of adds)
			if (!knCols.includes(col))
				db.run(`ALTER TABLE knowledge ADD COLUMN ${col} ${ddl}`);
		db.run("UPDATE knowledge SET created_at = ts WHERE created_at IS NULL");
		db.run(
			"UPDATE knowledge SET updated_at = COALESCE(updated_at, created_at, ts) WHERE updated_at IS NULL",
		);
	}
	// W91 #7: DBs that ran the earlier v6 draft hold a REGULAR fts5
	// knowledge_fts (its own text copy). Converge to external-content — drop,
	// recreate with content='knowledge', rebuild the index from knowledge rows,
	// and refresh the sync triggers to the documented external-content form.
	repairKnowledgeFts(db);
	const kqCols = columnNames(db, "knowledge_queue");
	if (kqCols.length && !kqCols.includes("origin_sid"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN origin_sid TEXT");
	// W100: enqueue-time provenance — the declared source_ref (normalized) and
	// the sha256 of the FILE it names at enqueue time (producer has repo
	// access), passed through claim() into the final row. NULL hash = the ref
	// did not resolve for the producer — honest, never a doomed value.
	if (kqCols.length && !kqCols.includes("source_ref"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN source_ref TEXT");
	if (kqCols.length && !kqCols.includes("source_hash"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN source_hash TEXT");
}

// W166 — knowledge.db: the knowledge workload's OWN SQLite/WAL file
// (docs/design/knowledge-db-2026-10-01.md): read-path pragmas for the FTS5
// hot path. Ordering: busy_timeout BEFORE journal_mode (the openGovernorDb
// shape — under contention the connection waits instead of throwing);
// page_size is baked at file creation, so 8192 rides every open (decisive
// on the first, a silent no-op once the file has pages).
export function openKnowledgeDb(): Database {
	mkdirSync(REG(), { recursive: true });
	const db = openWALDb(`${REG()}/knowledge.db`, "knowledge.db", 8192);
	db.run("PRAGMA mmap_size=1073741824");
	repairKnowledgeFts(db);
	// W381 (from parked/W208) curation engine: retire proposals from the
	// recency-decay sweep, disposed by a human (approve = the row retires,
	// dismiss = cooldown). Self-healing CREATE on every open (the
	// openGovernorDb doctrine); the partial unique index keeps at most ONE
	// open proposal per knowledge row.
	db.run(
		"CREATE TABLE IF NOT EXISTS knowledge_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, knowledge_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'retire', score REAL NOT NULL, age_days INTEGER NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', decided_by TEXT, decided_at INTEGER)",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposals_one_open ON knowledge_proposals (knowledge_id) WHERE state = 'open'",
	);
	// W244 — parser-change reprocess checkpoint. Guarded ALTERs heal every
	// pre-W244 knowledge.db (CREATE TABLE IF NOT EXISTS cannot upgrade a live
	// table); a fresh file without knowledge_queue is skipped — its schema
	// arrives with the v10 split and the next open heals it.
	const kqCols244 = columnNames(db, "knowledge_queue");
	if (kqCols244.length) {
		if (!kqCols244.includes("prompt_hash"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN prompt_hash TEXT");
		if (!kqCols244.includes("reprocessed_at"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN reprocessed_at INTEGER");
		if (!kqCols244.includes("reprocess_of"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN reprocess_of INTEGER");
	}
	// W836 — audit trust schema (best-of-audits lift): knowledge rows carry
	// {rating, detail, evidence, researched-date}; detail IS the existing
	// `fact` column (no duplicate). `rating`/`evidence`/`researched_at` are
	// stamped by the audit lane via `coord knowledge-grade` — the distill
	// indexer stays impartial (the prompt contract forbids quality judgment).
	// `graveyard_reason` holds why a row was buried — graveyards never delete.
	const kCols = columnNames(db, "knowledge");
	if (kCols.length) {
		if (!kCols.includes("rating"))
			db.run("ALTER TABLE knowledge ADD COLUMN rating TEXT");
		if (!kCols.includes("evidence"))
			db.run("ALTER TABLE knowledge ADD COLUMN evidence TEXT");
		if (!kCols.includes("researched_at"))
			db.run("ALTER TABLE knowledge ADD COLUMN researched_at INTEGER");
		if (!kCols.includes("graveyard_reason"))
			db.run("ALTER TABLE knowledge ADD COLUMN graveyard_reason TEXT");
		// W953 confidence doctrine: the stamp JSON rides the row next to the
		// scalar confidence column (present since the v6 schema).
		// W1226 fact provenance crosses the sync as structured evidence — the
		// hub-side knowledge row carries it alongside the W953 stamp JSON.
		if (!kCols.includes("provenance"))
			db.run("ALTER TABLE knowledge ADD COLUMN provenance TEXT");
		if (!kCols.includes("confidence_stamp"))
			db.run("ALTER TABLE knowledge ADD COLUMN confidence_stamp TEXT");
	}
	db.run(CONFIDENCE_HISTORY_DDL);
	db.run(CONFIDENCE_HISTORY_INDEX_DDL);
	db.run(
		"CREATE TABLE IF NOT EXISTS queue_checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), prompt_hash TEXT NOT NULL, ts INTEGER NOT NULL)",
	);
	return db;
}
