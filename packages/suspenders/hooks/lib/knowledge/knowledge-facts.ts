// hooks/lib/knowledge/knowledge-facts.ts — hub design phase 3: ONE knowledge
// store. Knowledge-shaped fact rows (lesson.*, finding.*, claim.*,
// decant.claim.*) leave governor.db `facts` for knowledge.db
// `knowledge_facts` — same columns (version/CAS, confidence stamp, W1226
// provenance, W1228 stale markers) plus origin_kind/source_ref provenance.
// governor `facts` keeps control-plane state only; `lesson.seen.<sid>` is
// session-start bookkeeping and stays there.
//
// The migration is idempotent and lazy: a read probe per prefix on the
// governor handle, knowledge.db opened only when rows remain. INSERT OR
// IGNORE then DELETE — an interrupted pass re-runs safely, and a row already
// written to knowledge_facts by a newer binary stays authoritative.
import { Database } from "bun:sqlite";
import { openKnowledgeDb } from "./govdb-knowledge.ts";

export const KNOWLEDGE_FACT_PREFIXES = [
	"lesson.",
	"finding.",
	"claim.",
	"decant.claim.",
] as const;
const SEEN = "lesson.seen.";

export function isKnowledgeFactKey(key: string): boolean {
	if (key.startsWith(SEEN)) return false;
	return KNOWLEDGE_FACT_PREFIXES.some((p) => key.startsWith(p));
}

/** origin_kind for a migrated/written key: decant's distiller is its own
 *  origin; the rest mirror the knowledge origin vocabulary. */
export function originKindOf(key: string): string {
	if (key.startsWith("decant.claim.")) return "decant";
	if (key.startsWith("claim.")) return "claim";
	if (key.startsWith("lesson.")) return "lesson";
	return "fact";
}

/** source_ref for a decant claim = the decant run/session evidence id its
 *  confidence stamp carries; null when the row has none. */
export function sourceRefOf(key: string, stamp: string | null): string | null {
	if (!key.startsWith("decant.claim.") || !stamp) return null;
	try {
		const ev = (JSON.parse(stamp) as { evidence?: unknown }).evidence;
		return typeof ev === "string" && ev ? `decant:${ev}` : null;
	} catch {
		return null;
	}
}

export const KF_COLUMNS =
	"key, value, source, version, ts, confidence, confidence_stamp, provenance, stale_at, stale_reason";

const DDL = [
	"CREATE TABLE IF NOT EXISTS knowledge_facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL, confidence REAL, confidence_stamp TEXT, provenance TEXT, stale_at INTEGER, stale_reason TEXT, origin_kind TEXT, source_ref TEXT)",
	"CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts_fts USING fts5(value, key, content='knowledge_facts', content_rowid='rowid')",
	"CREATE TRIGGER IF NOT EXISTS knowledge_facts_ai AFTER INSERT ON knowledge_facts BEGIN INSERT INTO knowledge_facts_fts (rowid, value, key) VALUES (new.rowid, new.value, new.key); END",
	"CREATE TRIGGER IF NOT EXISTS knowledge_facts_ad AFTER DELETE ON knowledge_facts BEGIN INSERT INTO knowledge_facts_fts (knowledge_facts_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key); END",
	"CREATE TRIGGER IF NOT EXISTS knowledge_facts_au AFTER UPDATE OF value, key ON knowledge_facts BEGIN INSERT INTO knowledge_facts_fts (knowledge_facts_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key); INSERT INTO knowledge_facts_fts (rowid, value, key) VALUES (new.rowid, new.value, new.key); END",
];

const ensured = new WeakSet<object>();
export function ensureKnowledgeFacts(kb: Database): void {
	if (ensured.has(kb)) return;
	for (const s of DDL) kb.run(s);
	ensured.add(kb);
}

type Gov = Pick<Database, "query">;
const upper = (p: string): string => `${p}${String.fromCharCode(0xffff)}`;

/** rows still in governor facts under a knowledge prefix (seen-markers excluded). */
function pendingCount(gov: Gov, p: string): number {
	const extra = p === "lesson." ? " AND NOT (key >= ? AND key < ?)" : "";
	const params =
		p === "lesson." ? [p, upper(p), SEEN, upper(SEEN)] : [p, upper(p)];
	try {
		return (
			(
				gov
					.query(
						`SELECT COUNT(*) AS n FROM facts WHERE key >= ? AND key < ?${extra}`,
					)
					.get(...params) as { n: number } | null
			)?.n ?? 0
		);
	} catch {
		return 0; // no facts table on this handle — nothing to move
	}
}

/** Move knowledge rows governor → knowledge.db. Returns rows moved. */
export function migrateKnowledgeFacts(
	gov: Gov,
	openKb: () => Database = openKnowledgeDb,
): number {
	const todo = KNOWLEDGE_FACT_PREFIXES.filter((p) => pendingCount(gov, p) > 0);
	if (!todo.length) return 0;
	const kb = openKb();
	let moved = 0;
	try {
		ensureKnowledgeFacts(kb);
		const ins = kb.query(
			`INSERT OR IGNORE INTO knowledge_facts (${KF_COLUMNS}, origin_kind, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		// legacy governor dbs may predate the confidence/provenance/stale ALTERs
		// (this runs before govdb-open heals them): absent columns read NULL
		const have = new Set(
			(gov.query("PRAGMA table_info(facts)").all() as { name: string }[]).map(
				(c) => c.name,
			),
		);
		const cols = KF_COLUMNS.split(", ")
			.map((c) => (have.has(c) ? c : `NULL AS ${c}`))
			.join(", ");
		for (const p of todo) {
			const rows = gov
				.query(
					`SELECT ${cols} FROM facts WHERE key >= ? AND key < ? ORDER BY key`,
				)
				.all(p, upper(p)) as KnowledgeFactRow[];
			const keep = rows.filter((r) => isKnowledgeFactKey(r.key));
			kb.transaction(() => {
				for (const r of keep)
					ins.run(
						r.key,
						r.value,
						r.source,
						r.version,
						r.ts,
						r.confidence,
						r.confidence_stamp,
						r.provenance,
						r.stale_at,
						r.stale_reason,
						originKindOf(r.key),
						sourceRefOf(r.key, r.confidence_stamp),
					);
			})();
			const del = gov.query("DELETE FROM facts WHERE key = ?");
			for (const r of keep) del.run(r.key);
			moved += keep.length;
		}
	} finally {
		kb.close();
	}
	return moved;
}

export interface KnowledgeFactRow {
	key: string;
	value: string | null;
	source: string | null;
	version: number;
	ts: number;
	confidence: number | null;
	confidence_stamp: string | null;
	provenance: string | null;
	stale_at: number | null;
	stale_reason: string | null;
}

/** The read API: knowledge fact rows by prefix, newest/keyed order, bounded. */
export function listKnowledgeFacts(
	kb: Database,
	opts: {
		prefixes: readonly string[];
		since?: number;
		order?: "key" | "ts" | "ts_desc";
		limit?: number;
	},
): KnowledgeFactRow[] {
	ensureKnowledgeFacts(kb);
	const where = opts.prefixes.map(() => "(key >= ? AND key < ?)").join(" OR ");
	const params: (string | number)[] = opts.prefixes.flatMap((p) => [
		p,
		upper(p),
	]);
	let sql = `SELECT ${KF_COLUMNS} FROM knowledge_facts WHERE (${where || "0"})`;
	if (opts.since != null) {
		sql += " AND ts > ?";
		params.push(opts.since);
	}
	sql +=
		opts.order === "ts"
			? " ORDER BY ts"
			: opts.order === "ts_desc"
				? " ORDER BY ts DESC"
				: " ORDER BY key";
	if (opts.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
	return (kb.query(sql).all(...params) as KnowledgeFactRow[]).filter((r) =>
		isKnowledgeFactKey(r.key),
	);
}

/** Read-side convenience for callers without a kb handle in hand. */
/** knowledge.db beside a governor.db path (same REG dir). */
export function siblingKnowledgeDb(govPath: string | null): string | null {
	return govPath ? govPath.replace(/governor\.db$/, "knowledge.db") : null;
}

export function withKnowledgeFacts<T>(fn: (kb: Database) => T): T {
	const kb = openKnowledgeDb();
	try {
		ensureKnowledgeFacts(kb);
		return fn(kb);
	} finally {
		kb.close();
	}
}

/** Read-only sync seam (knowledge-sync / knowledge-roll open their dbs
 *  READONLY, no migration on that path): the governor rows the caller read
 *  merged with knowledge.db knowledge_facts rows under the same prefixes —
 *  the knowledge store wins per key. A missing knowledge.db or table (a
 *  pre-phase-3 spoke) returns the governor rows untouched. */
export function mergeKnowledgeFactsReadonly<T extends { key: string }>(
	govRows: T[],
	kbPath: string | null,
	prefixes: readonly string[],
): T[] {
	if (!kbPath) return govRows;
	let kb: Database | null = null;
	try {
		kb = new Database(kbPath, { readonly: true, create: false });
		const has = kb
			.query(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_facts'",
			)
			.get();
		if (!has) return govRows;
		const where = prefixes.map(() => "(key >= ? AND key < ?)").join(" OR ");
		const kbRows = kb
			.query(`SELECT ${KF_COLUMNS} FROM knowledge_facts WHERE ${where}`)
			.all(...prefixes.flatMap((p) => [p, upper(p)])) as unknown as T[];
		const byKey = new Map<string, T>();
		for (const r of govRows) byKey.set(r.key, r);
		for (const r of kbRows) if (isKnowledgeFactKey(r.key)) byKey.set(r.key, r);
		return [...byKey.values()].sort((a, b) =>
			a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
		);
	} catch {
		return govRows;
	} finally {
		kb?.close();
	}
}
