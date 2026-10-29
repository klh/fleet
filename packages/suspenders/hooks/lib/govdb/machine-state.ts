// hooks/lib/govdb/machine-state.ts — machine telemetry keyspace (hub design
// D3, docs/design/hub-control-plane-consult-knowledge.md). `facts` is the
// human/knowledge surface: every write there fires the facts_fts triggers and
// the deltas audit log. High-churn machine bookkeeping (harvest cursors and
// seen-markers, metrics snapshots/token caches, monitor deadletters, executor
// CV rows) rode facts and drove ~1M delta rows in a month (deltas = 596 MB).
// machine_state has the machine_cursors shape (govdb v12 precedent) with NO
// FTS and NO delta triggers, and the upsert skips no-op rewrites.
//
// The migration is idempotent and cheap on every open: each prefix is a PK
// range scan ([p, p+U+FFFF)), so an already-migrated db costs four empty
// index probes.
type Bind = string | number | null;
interface MsStatement {
	run(...params: Bind[]): { changes: number };
	get(...params: Bind[]): unknown;
	all(...params: Bind[]): unknown[];
}
/** Structural handle: a GovernorStore and a bun:sqlite Database both fit. */
export interface MsDb {
	query(sql: string): MsStatement;
	run(sql: string): unknown;
}

export const MACHINE_STATE_PREFIXES = [
	"harvest.",
	"metrics.",
	"deadletter.",
	"executor.",
] as const;

const DDL =
	"CREATE TABLE IF NOT EXISTS machine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)";

const ensured = new WeakSet<object>();

/** Create the table once per store handle (a store-server that predates this
 *  code never ran the open-time DDL, so writers ensure lazily). */
export function ensureMachineState(db: MsDb): void {
	if (ensured.has(db)) return;
	db.run(DDL);
	ensured.add(db);
}

const upper = (p: string): string => `${p}\uffff`;

/** Move telemetry rows out of facts (INSERT OR IGNORE keeps a newer
 *  machine_state row authoritative), then delete them from facts. */
export function migrateMachineState(db: MsDb): number {
	ensureMachineState(db);
	let moved = 0;
	for (const p of MACHINE_STATE_PREFIXES) {
		// read-probe first: an already-migrated db must never take the write
		// lock on open (every CLI open would contend with live writers —
		// verb-surface caught BUSY). Counting first also dodges DELETE
		// .changes, which includes the facts_fts/deltas trigger writes.
		const n = (
			db
				.query("SELECT COUNT(*) AS n FROM facts WHERE key >= ? AND key < ?")
				.get(p, upper(p)) as { n: number } | null
		)?.n;
		if (!n) continue;
		// INSERT OR IGNORE then DELETE: an interrupted pass re-runs safely
		db.query(
			"INSERT OR IGNORE INTO machine_state (key, value, source, ts) SELECT key, value, COALESCE(source, ''), ts FROM facts WHERE key >= ? AND key < ?",
		).run(p, upper(p));
		db.query("DELETE FROM facts WHERE key >= ? AND key < ?").run(p, upper(p));
		moved += n;
	}
	return moved;
}

export function msGet(db: MsDb, key: string): string | null {
	ensureMachineState(db);
	return (
		(
			db.query("SELECT value FROM machine_state WHERE key = ?").get(key) as {
				value: string;
			} | null
		)?.value ?? null
	);
}

/** Upsert; an unchanged value is a no-op (no write, no WAL page). */
export function msSet(
	db: MsDb,
	key: string,
	value: string,
	source = "",
	ts = Date.now(),
): void {
	ensureMachineState(db);
	db.query(
		"INSERT INTO machine_state (key, value, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts WHERE machine_state.value IS NOT excluded.value",
	).run(key, value, source, ts);
}

export function msList(
	db: MsDb,
	prefix: string,
): { key: string; value: string; ts: number }[] {
	ensureMachineState(db);
	return db
		.query(
			"SELECT key, value, ts FROM machine_state WHERE key >= ? AND key < ? ORDER BY key",
		)
		.all(prefix, upper(prefix)) as { key: string; value: string; ts: number }[];
}

export function msDelete(db: MsDb, key: string): void {
	ensureMachineState(db);
	db.query("DELETE FROM machine_state WHERE key = ?").run(key);
}
