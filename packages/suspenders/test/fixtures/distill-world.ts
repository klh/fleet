// test/fixtures/distill-world.ts — the idle distiller's scratch world: a
// knowledge.db with the production knowledge + proposals columns, the real
// SqliteKnowledgeStore behind the sink, serveStub upstreams for embeddings /
// rerank / chat (deterministic bag-of-words vectors), a programmable Kev, a
// mutable idle-signal source, and a decant.db built from decant's OWN
// schema.sql (schema-matching by construction).
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStub } from "@klh/test-kit";
import type {
	CurationChoice,
	CurationInput,
} from "../../hooks/lib/knowledge/kev-curation.ts";
import { SqliteKnowledgeStore } from "../../hooks/lib/knowledge/sqlite-store.ts";
import {
	chatClient,
	embedClient,
	rerankClient,
} from "../../hooks/lib/knowledge/distill/clients.ts";
import { distillDefaults } from "../../hooks/lib/knowledge/distill/config.ts";
import type { DistillDeps } from "../../hooks/lib/knowledge/distill/runner.ts";
import { ensureDistillSchema } from "../../hooks/lib/knowledge/distill/schema.ts";
import { storeSink } from "../../hooks/lib/knowledge/distill/sink.ts";

const KNOWLEDGE_DDL =
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER, rating TEXT, evidence TEXT, researched_at INTEGER, graveyard_reason TEXT, provenance TEXT, confidence_stamp TEXT, stale_at INTEGER, stale_reason TEXT, version INTEGER)";
const PROPOSALS_DDL =
	"CREATE TABLE knowledge_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, knowledge_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'retire', score REAL NOT NULL, age_days INTEGER NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', decided_by TEXT, decided_at INTEGER, payload TEXT)";

export function knowledgeDb(): Database {
	const db = new Database(":memory:");
	db.run(KNOWLEDGE_DDL);
	db.run(PROPOSALS_DDL);
	db.run(
		"CREATE UNIQUE INDEX knowledge_proposals_one_open ON knowledge_proposals (knowledge_id) WHERE state = 'open'",
	);
	ensureDistillSchema(db);
	return db;
}

export interface EntrySeed {
	topic: string;
	fact: string;
	state?: string;
	sourceRef?: string | null;
	sourceHash?: string | null;
	originKind?: string | null;
	originSid?: string | null;
	confidence?: number;
	ts?: number;
}

let clock = 1_000;
export function addEntry(db: Database, e: EntrySeed): number {
	const t = e.ts ?? clock++;
	return Number(
		db
			.query(
				"INSERT INTO knowledge (ts, topic, fact, confidence, state, source_ref, source_hash, origin_kind, origin_sid, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
			)
			.run(
				t,
				e.topic,
				e.fact,
				e.confidence ?? 0.5,
				e.state ?? "active",
				e.sourceRef ?? null,
				e.sourceHash ?? null,
				e.originKind ?? null,
				e.originSid ?? null,
				t,
				t,
			).lastInsertRowid,
	);
}

export const fileHash = (path: string): string =>
	createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");

/** Deterministic 64-dim bag-of-words vector — similar text, high cosine. */
export function bowVector(text: string): number[] {
	const v = new Array<number>(64).fill(0);
	for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
		const h = createHash("md5").update(w).digest();
		v[(h[0] ?? 0) % 64] = (v[(h[0] ?? 0) % 64] ?? 0) + 1;
	}
	return v;
}

export interface ChatScript {
	/** answer for a chat call (system prompt, user text) → content */
	answer: (system: string, user: string) => string;
	tokens: number;
	status?: number;
}

export function upstreams(chat: ChatScript) {
	const embed = serveStub((_req, body) => {
		const input = (body?.input ?? []) as string[];
		return Response.json({
			data: input.map((t, index) => ({ index, embedding: bowVector(t) })),
		});
	});
	const chatStub = serveStub((_req, body) => {
		if (chat.status && chat.status !== 200)
			return new Response("busy", { status: chat.status });
		const msgs = (body?.messages ?? []) as { content: string }[];
		return Response.json({
			choices: [{ message: { content: chat.answer(msgs[0]?.content ?? "", msgs[1]?.content ?? "") } }],
			usage: { total_tokens: chat.tokens },
		});
	});
	const rerank = serveStub((_req, body) => {
		const docs = (body?.documents ?? []) as string[];
		return Response.json({
			results: docs.map((_d, index) => ({ index, relevance_score: 0.9 })),
		});
	});
	return {
		embed,
		chat: chatStub,
		rerank,
		close() {
			embed.close();
			chatStub.close();
			rerank.close();
		},
	};
}

export interface WorldOpts {
	cfg?: Record<string, unknown>;
	chat?: ChatScript;
	kev?: (i: CurationInput) => CurationChoice;
	decant?: Database | null;
	logDir: string;
	withRerank?: boolean;
}

export interface Signals {
	liveLanes: number;
	interactiveAt: number | null;
	pressure: number | null;
	/** flip to busy after this many signal reads (preemption tests) */
	busyAfter?: number;
}

export function world(db: Database, o: WorldOpts) {
	const chat = o.chat ?? { answer: () => "{\"skip\":true}", tokens: 10 };
	const up = upstreams(chat);
	const cfg = distillDefaults({
		enabled: true,
		embed_url: `${up.embed.url}/v1/embeddings`,
		...(o.withRerank ? { rerank_url: `${up.rerank.url}/v1/rerank` } : {}),
		min_revisit_h: 0,
		...(o.cfg ?? {}),
	});
	const signals: Signals = { liveLanes: 0, interactiveAt: null, pressure: null };
	let reads = 0;
	const kevCalls: CurationInput[] = [];
	const events: { kind: string; payload: Record<string, unknown> }[] = [];
	const deps: DistillDeps = {
		db,
		cfg,
		clients: {
			embed: embedClient(cfg),
			rerank: o.withRerank ? rerankClient(`${up.rerank.url}/v1/rerank`, cfg.rerank_model) : null,
			chat: chatClient({ front: new URL(`${up.chat.url}/`), token: "bksk_test" }, cfg.model_group),
		},
		sink: storeSink(db, new SqliteKnowledgeStore(db, db), async (i) => {
			kevCalls.push(i);
			return {
				kind: i.kind,
				reference: i.reference,
				choice: o.kev ? o.kev(i) : "store",
				confidence: 0.9,
				model: "kev-stub",
				suggestion: "",
			};
		}),
		decant: o.decant ?? null,
		signals: async () => {
			reads++;
			const busy = signals.busyAfter !== undefined && reads > signals.busyAfter;
			return {
				liveLanes: busy ? 5 : signals.liveLanes,
				interactiveAt: signals.interactiveAt,
				pressure: signals.pressure,
				now: Date.now(),
			};
		},
		emit: (kind, payload) => {
			events.push({ kind, payload });
		},
		logPath: join(o.logDir, "distill-runs.jsonl"),
		pausePath: join(o.logDir, "distill-paused"),
		nonce: crypto.randomUUID(),
	};
	return {
		deps,
		cfg,
		signals,
		kevCalls,
		events,
		up,
		resetReads() {
			reads = 0;
		},
		close: () => up.close(),
	};
}

/** A decant.db built from decant's own schema.sql (path = file to create). */
export function decantDb(path: string): Database {
	const db = new Database(path);
	const ddl = readFileSync(join(import.meta.dir, "../../../decant/src/schema.sql"), "utf8");
	db.exec(ddl);
	return db;
}

export interface DecantSessionSeed {
	tool?: string;
	sid: string;
	project: string;
	title: string;
	branch?: string;
	files?: { path: string; op: string }[];
	commands?: string[];
	ingestedAt: string;
}

export function addDecantSession(db: Database, s: DecantSessionSeed): number {
	db.query("INSERT OR IGNORE INTO project (path, name) VALUES (?, ?)").run(
		s.project,
		s.project.split("/").pop() ?? s.project,
	);
	const pid = (db.query("SELECT id FROM project WHERE path = ?").get(s.project) as { id: number }).id;
	const id = Number(
		db
			.query(
				"INSERT INTO session (tool, source_session_id, project_id, title, git_branch, ingested_at, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(s.tool ?? "claude", s.sid, pid, s.title, s.branch ?? null, s.ingestedAt, `h-${s.sid}`)
			.lastInsertRowid,
	);
	for (const f of s.files ?? [])
		db.query("INSERT INTO file_ref (session_id, path, rel_path, operation) VALUES (?, ?, ?, ?)").run(
			id,
			f.path,
			null,
			f.op,
		);
	for (const c of s.commands ?? [])
		db.query(
			"INSERT INTO tool_call (session_id, tool_name, tool_base_name, input) VALUES (?, 'Bash', 'Bash', ?)",
		).run(id, JSON.stringify({ command: c }));
	return id;
}
