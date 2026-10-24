// bench/w1219 — the sink REPLICA: the real knowledge.db built by the REAL
// openKnowledgeDb code path (schema can never drift from the sink's), at a
// HOME-pinned temp root (the ?home= test convention — REG pins per load).
import { mkdirSync, rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { join } from "node:path";

export interface Replica {
	/** the replica root REG() pointed at while building */
	root: string;
	/** the knowledge.db file (the sink's own store) */
	dbPath: string;
	/** prompt-side schema text: the 4 sink tables, compact CREATE form */
	schemaText: string;
	/** close + delete the replica */
	close(): void;
}

/** HOME-pinned openKnowledgeDb — the REAL sink schema builder. */
export async function openReplicaDb(root: string): Promise<Database> {
	const prev = process.env.HOME;
	process.env.HOME = root;
	try {
		// cache-bust so govdb-util's REG re-pins to the replica root (W624)
		const mod = await import(
			`../../hooks/lib/govdb-knowledge.ts?home=${crypto.randomUUID()}`,
		);
		return mod.openKnowledgeDb();
	} finally {
		process.env.HOME = prev;
	}
}

/** The sink schema the candidates see — verbatim column sets from the
 *  openKnowledgeDb DDL (knowledge, knowledge_claims, knowledge_proposals,
 *  knowledge_queue), compacted to one CREATE per table. */
export const SCHEMA_TEXT = [
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, origin_sid TEXT, contributors TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER)",
	"CREATE TABLE knowledge_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_hash TEXT NOT NULL UNIQUE, evidence_id TEXT NOT NULL, claim TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, version INTEGER NOT NULL DEFAULT 1, tombstone INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, updated_at INTEGER NOT NULL, origin_machine TEXT NOT NULL, provenance TEXT NOT NULL, tombstone_ts INTEGER, scope TEXT NOT NULL DEFAULT 'fleet')",
	"CREATE TABLE knowledge_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, knowledge_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'retire', score REAL NOT NULL, age_days INTEGER NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', decided_by TEXT, decided_at INTEGER)",
	"CREATE TABLE knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0)",
].join("\n");

const T0 = 1760000000000; // fixed seed epoch — runs stay comparable

/** Seed a knowledge row via the real store-side columns. */
interface SeedKnowledge {
	topic: string;
	fact: string;
	confidence?: number;
	state?: string;
	origin_kind?: string;
	source?: string;
	graveyard_reason?: string;
	ts?: number;
}

const KNOW: SeedKnowledge[] = [
	{
		topic: "buckle-auth-chain",
		fact: "root key mints admin keys; admin mints per-lane bksk_ keys",
		confidence: 0.9,
		state: "active",
		origin_kind: "lane",
		source: "knowledge-worker",
	},
	{
		topic: "fleet-push-gate",
		fact: "push must be a bare command; pipes break scope proof",
		confidence: 0.85,
		state: "active",
		origin_kind: "lane",
		source: "coord-fact",
	},
	{
		topic: "sink-schema",
		fact: "knowledge.db holds knowledge, claims, proposals, queue",
		confidence: 0.8,
		state: "active",
		origin_kind: "lane",
		source: "knowledge-worker",
	},
	{
		topic: "nas-deploy",
		fact: "hub containers pull git-pulled volumes; no host-path deploys",
		confidence: 0.7,
		state: "candidate",
		origin_kind: "lane",
		source: "coord-fact",
	},
	{
		topic: "retired-row",
		fact: "superseded guidance kept for audit",
		confidence: 0.4,
		state: "retired",
		origin_kind: "human",
		source: "knowledge-worker",
	},
	{
		topic: "graveyard-row",
		fact: "buried row kept, never deleted",
		confidence: 0.2,
		state: "candidate",
		graveyard_reason: "stale",
		origin_kind: "human",
		source: "knowledge-worker",
	},
];

/** One claim version to seed (rolled up via the real roll table). */
interface SeedClaim {
	evidence_id: string;
	claim: string;
	confidence: number;
	version: number;
	tombstone?: boolean;
	origin_machine: string;
	provenance: { machine: string; ts: number; retract?: boolean }[];
	scope?: string;
}

const CLAIMS: SeedClaim[] = [
	{
		evidence_id: "w-l1",
		claim: "the gate blocks past 1500 lines",
		confidence: 0.9,
		version: 1,
		origin_machine: "mac-studio",
		provenance: [{ machine: "mac-studio", ts: T0 }],
	},
	{
		evidence_id: "w-l1",
		claim: "the gate blocks past 1500 lines (v2 wording)",
		confidence: 0.92,
		version: 2,
		origin_machine: "nas",
		provenance: [
			{ machine: "mac-studio", ts: T0 },
			{ machine: "nas", ts: T0 + 1000 },
		],
	},
	{
		evidence_id: "w-l1",
		claim: "the gate blocks past 1500 lines (v3 wording)",
		confidence: 0.95,
		version: 3,
		origin_machine: "nas",
		provenance: [
			{ machine: "mac-studio", ts: T0 },
			{ machine: "nas", ts: T0 + 1000 },
		],
	},
	{
		evidence_id: "w-l2",
		claim: "push scope proof needs a bare command",
		confidence: 0.8,
		version: 1,
		origin_machine: "mac-studio",
		provenance: [{ machine: "mac-studio", ts: T0 + 2000 }],
	},
	{
		evidence_id: "w-l3",
		claim: "retracted: stale endpoint list",
		confidence: 0.6,
		version: 2,
		tombstone: true,
		origin_machine: "nas",
		provenance: [
			{ machine: "nas", ts: T0 + 3000 },
			{ machine: "nas", ts: T0 + 4000, retract: true },
		],
	},
];

/** Build the replica: REAL openKnowledgeDb at a temp REG root + seed rows
 *  that mirror a live sink (states, tombstones, multi-version claims,
 *  proposals). Returns the handle; caller closes. */
export async function buildReplica(root: string): Promise<Replica> {
	const reg = join(root, ".cache", "claude-governor");
	mkdirSync(reg, { recursive: true });
	const db = await openReplicaDb(root);
	const healthy = [
		// openKnowledgeDb self-heals claims/proposals/checkpoint, but the
		// knowledge + queue + FTS faces arrive ONLY via the v10 split from a
		// v6-era governor.db — a fresh sink volume lacks them (finding.w1219
		// fresh-sink-tables). The replica mirrors the HEALTHY sink shape.
		...SCHEMA_TEXT.split("\n").map((ddl) =>
			ddl.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
		),
		"CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')",
		"CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
		"CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END",
		"CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
	];
	for (const ddl of healthy) db.run(ddl);
	// second open on the now-complete schema — the guarded W836/W1226 ALTERs
	// (rating/evidence/provenance/…) ride openKnowledgeDb and need the table
	// present; the healthy sink got them from the same healing on live DBs.
	db.close();
	const healed = await openReplicaDb(root);
	const ins = healed.query(
		`INSERT INTO knowledge (ts, topic, fact, confidence, domain, area,
origin_kind, origin_system, origin_sid, contributors, source, state,
superseded_by, created_at, updated_at, hub_eligible, graveyard_reason)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	for (const [i, k] of KNOW.entries()) {
		ins.run(
			k.ts ?? T0 + i * 100,
			k.topic,
			k.fact,
			k.confidence ?? 0.5,
			"fleet",
			"bench",
			k.origin_kind ?? "lane",
			"w1219",
			"autow1219-p98b319584008df14",
			null,
			k.source ?? "knowledge-worker",
			k.state ?? "candidate",
			null,
			k.ts ?? T0 + i * 100,
			k.ts ?? T0 + i * 100,
			1,
			k.graveyard_reason ?? null,
		);
	}
	const cs = healed.query(
		`INSERT INTO knowledge_claims (claim_hash, evidence_id, claim,
confidence, version, tombstone, ts, updated_at, origin_machine, provenance,
tombstone_ts, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	for (const [i, c] of CLAIMS.entries()) {
		cs.run(
			`h${i}-seed`,
			c.evidence_id,
			c.claim,
			c.confidence,
			c.version,
			c.tombstone ? 1 : 0,
			T0 + i * 500,
			T0 + i * 500,
			c.origin_machine,
			JSON.stringify(c.provenance),
			c.tombstone ? T0 + 9000 : null,
			c.scope ?? "fleet",
		);
	}
	healed.run(
		`INSERT INTO knowledge_proposals
(ts, knowledge_id, kind, score, age_days, confidence, reason, state)
VALUES (?,?,?,?,?,?,?,?)`,
		T0 + 5000, 5, "retire", 0.6, 45, 0.9, "age decay sweep", "open",
	);
	healed.run(
		`INSERT INTO knowledge_proposals
(ts, knowledge_id, kind, score, age_days, confidence, reason, state)
VALUES (?,?,?,?,?,?,?,?)`,
		T0 + 5100, 6, "retire", 0.75, 60, 0.9, "age decay sweep", "open",
	);
	healed.run(
		`INSERT INTO knowledge_queue (ts, source, payload, state, attempts)
VALUES (?,?,?,?,?)`,
		T0 + 6000, "bench", "seed payload", "done", 1,
	);
	const dbPath = join(reg, "knowledge.db");
	healed.close();
	return {
		root: reg,
		dbPath,
		schemaText: SCHEMA_TEXT,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
