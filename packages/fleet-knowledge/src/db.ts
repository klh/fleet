// src/db.ts — SQLite helpers shared by every store in this repo: the
// registry-root resolver (REG), the column probe, and the one WAL-open
// shape (busy_timeout BEFORE journal_mode; WAL verified on open). REG
// defaults to the fleet-compatible governor registry root
// (`$HOME/.cache/claude-governor`) so a fleet install keeps working
// unchanged; knowledge.db and the events bus derive their paths from it.
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
	migrateKnowledgeLayer,
	migrateKnowledgeSplit,
} from "./knowledge-db.ts";
import { migrateKnowledgeFacts } from "./knowledge-facts.ts";

// the governor registry root — resolved LAZILY at call time from the
// environment so every module instance (plain or cache-busted under bun
// test) converges on the caller's HOME; load-time pins made busted imports
// silently fall through their relative ./db.ts edge to a stale pinned
// instance and write the REAL registry (proven: test seeds landed in the
// live knowledge.db). pinReg() freezes it for entries that splice env
// mid-run (fleet-lane semantics — kept for parity, no callers here).
let REG_ROOT: string | null = null;
export const REG = (): string =>
	REG_ROOT ?? `${process.env.HOME}/.cache/claude-governor`;
export const pinReg = (): string => {
	REG_ROOT = `${process.env.HOME}/.cache/claude-governor`;
	return REG_ROOT;
};

// PRAGMA table_info → column names: the guarded-ALTER probe every migration
// step runs before ADD COLUMN. Table names are caller-supplied literals.
export const columnNames = (db: Database, table: string): string[] =>
	(db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
		(c) => c.name,
	);

// the one WAL-open shape, shared verbatim by openGovernorDb/openKnowledgeDb:
// busy_timeout BEFORE journal_mode (under contention the connection waits
// instead of throwing; WAL is persistent once set and verified on open);
// page_size before journal_mode when given (it bakes at file creation).
export function openWALDb(
	file: string,
	label: string,
	pageSize?: number,
): Database {
	const db = new Database(file, { create: true });
	// W1274: 2s lost claims under burst load — a `work take` that waited out
	// the old window surfaced "database is locked" and dispatch read it as a
	// claim verdict (SKIP, exit 0) instead of contention. 10s rides out the
	// bursts; the HTTP store's begin ladder already tolerates 35s (govdb-store.ts).
	db.run("PRAGMA busy_timeout=10000");
	if (pageSize) db.run(`PRAGMA page_size=${pageSize}`);
	try {
		db.run("PRAGMA journal_mode=WAL");
	} catch {
		const mode = (
			db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
		)?.journal_mode;
		if (mode?.toLowerCase() !== "wal")
			throw new Error(`${label} WAL unavailable (got: ${mode ?? "unknown"})`);
	}
	db.run("PRAGMA synchronous=NORMAL");
	return db;
}

// Minimal events-bus subset of the fleet governor.db schema: the table the
// knowledge layer's bus INSERTs land in (SqliteKnowledgeStore.emitLanded /
// curateRecord). Standalone installs get a self-sufficient bus; a fleet
// install opens the REAL governor.db whose full schema lives in fleet
// (govdb-open.ts) — this CREATE IF NOT EXISTS is a no-op
// there, so both worlds share one opener.
export function openGovernorDb(): Database {
	// fleet's host bootstrap pre-creates the registry root; a standalone
	// install has no such guarantee — self-heal it here (openKnowledgeDb
	// already does the same for its own path).
	mkdirSync(REG(), { recursive: true });
	const db = openWALDb(`${REG()}/governor.db`, "governor bus");
	db.run(
		"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	const evCols = columnNames(db, "events");
	if (!evCols.includes("target"))
		db.run("ALTER TABLE events ADD COLUMN target TEXT");
	db.run(
		"CREATE TABLE IF NOT EXISTS cursors (sid TEXT PRIMARY KEY, event_id INTEGER NOT NULL)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS direct_message_receipts (event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, sid TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED', queued_at INTEGER NOT NULL, seen_at INTEGER, accepted_at INTEGER)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS direct_message_receipts_sid_state ON direct_message_receipts(sid, state, event_id)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS route_audit (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, dialect TEXT, hint TEXT NOT NULL DEFAULT '', candidates TEXT, resolved_target TEXT, decision TEXT NOT NULL, latency_class TEXT, error_code TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS route_audit_ts ON route_audit(ts, rid)");
	// ── the knowledge ladder ────────────────────────────────────────────
	// the knowledge-plane rungs of fleet's govdb-open schema ladder, in the
	// same order and with the same user_version gating (a fleet governor.db
	// opens here unchanged; a fresh file climbs the same rungs).
	const uv = Number(
		(db.query("PRAGMA user_version").get() as { user_version?: number })
			.user_version ?? 0,
	);
	if (uv < 4) {
		db.run(
			"CREATE TABLE IF NOT EXISTS consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, asked_by TEXT NOT NULL, answered_by TEXT NOT NULL, consult_id INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL)",
		);
		db.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS consult_kb_fts USING fts5(problem)",
		);
		db.run("PRAGMA user_version = 4");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	migrateKnowledgeLayer(db, uv);
	if (uv < 9) {
		const kqCols9 = columnNames(db, "knowledge_queue");
		if (kqCols9.length && !kqCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN hub_eligible INTEGER");
		const knCols9 = columnNames(db, "knowledge");
		if (knCols9.length && !knCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge ADD COLUMN hub_eligible INTEGER");
		db.run("PRAGMA user_version = 9");
	}
	if (uv < 10) migrateKnowledgeSplit(db);
	migrateKnowledgeFacts(db);
	return db;
}

// store-tx.ts's tx-heal/watchdog helpers take this handle; the real fleet
// GovernorStore satisfies it structurally (it exposes .run).
export type GovernorStore = Database;
