// hooks/lib/govdb-util.ts — leaf helpers shared by the govdb modules (W624
// split). REG is a shared root re-pinned at every govdb.ts entry-instance
// load (pinReg, called from the entry's module scope): the ?home= test
// convention (set HOME → cache-busted import → restore HOME) keeps its
// per-suite isolation because bun test evaluates file scopes sequentially;
// in production the single unqueried instance pins once, identical to the
// old first-require pin.
import { Database } from "bun:sqlite";

// the governor registry root — pinned by the entry at instance load, read at
// use time by every govdb module.
let REG_ROOT = `${process.env.HOME}/.cache/claude-governor`;
export const REG = (): string => REG_ROOT;
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
	db.run("PRAGMA busy_timeout=2000");
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
