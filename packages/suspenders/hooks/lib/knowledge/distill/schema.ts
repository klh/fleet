// distill/schema.ts — the distiller's tables in knowledge.db: the property
// graph (kg_nodes / kg_edges / kg_vectors), the per-entry visit ledger, run
// rows, the daily token book, judged pairs, distilled clusters and the hub
// lease. Idempotent migrations that READ-PROBE sqlite_master first and only
// issue DDL for what is missing — an already-migrated file costs one SELECT
// and takes no write lock (the 30df71d8 doctrine).
import type { Database } from "bun:sqlite";

const TABLES: [string, string][] = [
	[
		"kg_nodes",
		"CREATE TABLE kg_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', props TEXT NOT NULL DEFAULT '{}', hash TEXT, ref TEXT, usage INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, edge_at INTEGER NOT NULL DEFAULT 0, UNIQUE (kind, key))",
	],
	[
		"kg_edges",
		"CREATE TABLE kg_edges (src INTEGER NOT NULL, dst INTEGER NOT NULL, type TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, evidence_ref TEXT, created_by TEXT NOT NULL, confidence REAL, state TEXT NOT NULL DEFAULT 'candidate', at INTEGER NOT NULL, UNIQUE (src, dst, type))",
	],
	[
		"kg_vectors",
		"CREATE TABLE kg_vectors (node_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL)",
	],
	[
		"distill_visits",
		"CREATE TABLE distill_visits (entry_id INTEGER NOT NULL, job TEXT NOT NULL, last_visited_at INTEGER NOT NULL, last_hash TEXT, last_usage INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (entry_id, job)) WITHOUT ROWID",
	],
	[
		"distill_runs",
		"CREATE TABLE distill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL, stopped_job TEXT, stopped_entry INTEGER, items INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, preempted INTEGER NOT NULL DEFAULT 0, detail TEXT)",
	],
	[
		"distill_budget",
		"CREATE TABLE distill_budget (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0)",
	],
	[
		"distill_pairs",
		"CREATE TABLE distill_pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, job TEXT NOT NULL, sig TEXT NOT NULL, verdict TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b, job)) WITHOUT ROWID",
	],
	[
		"distill_clusters",
		"CREATE TABLE distill_clusters (sig TEXT PRIMARY KEY, state TEXT NOT NULL, knowledge_id INTEGER, draft TEXT, at INTEGER NOT NULL)",
	],
	[
		"distill_lease",
		"CREATE TABLE distill_lease (id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL, birth TEXT NOT NULL, started_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL)",
	],
	[
		"distill_state",
		"CREATE TABLE distill_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	],
	[
		// peer vote tallies landed off the wire — one row per (entry content
		// key, origin machine); tallies never sum across origins
		"kg_peer_votes",
		"CREATE TABLE kg_peer_votes (key TEXT NOT NULL, origin TEXT NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL, down_lanes INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, origin)) WITHOUT ROWID",
	],
];

const INDEXES: [string, string][] = [
	[
		"kg_edges_src_type",
		"CREATE INDEX kg_edges_src_type ON kg_edges (src, type)",
	],
	[
		"kg_edges_dst_type",
		"CREATE INDEX kg_edges_dst_type ON kg_edges (dst, type)",
	],
	["kg_nodes_ref", "CREATE INDEX kg_nodes_ref ON kg_nodes (ref)"],
	[
		"kg_nodes_kind_state",
		"CREATE INDEX kg_nodes_kind_state ON kg_nodes (kind, state)",
	],
];

/** Missing objects only — read-probe first, then DDL in one transaction. */
export function ensureDistillSchema(db: Database): void {
	const have = new Set(
		(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'kg\\_%' ESCAPE '\\' OR name LIKE 'distill\\_%' ESCAPE '\\')",
				)
				.all() as { name: string }[]
		).map((r) => r.name),
	);
	const missing = [...TABLES, ...INDEXES].filter(([name]) => !have.has(name));
	if (!missing.length) return;
	db.transaction(() => {
		for (const [, ddl] of missing) db.run(ddl);
	})();
}

export const getState = (db: Database, key: string): string | null =>
	(
		db.query("SELECT value FROM distill_state WHERE key = ?").get(key) as {
			value: string;
		} | null
	)?.value ?? null;

export const setState = (db: Database, key: string, value: string): void => {
	db.query(
		"INSERT INTO distill_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	).run(key, value);
};
