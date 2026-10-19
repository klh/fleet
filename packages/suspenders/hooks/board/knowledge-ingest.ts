// hooks/board/knowledge-ingest.ts — W944: the HUB side of the spoke→hub
// knowledge sync. POST /api/knowledge-ingest lands two classes:
//
//   facts → kb.knowledge rows, ALWAYS state='candidate' (the unverified
//     trust marker; the hub's W142 gate — human knowledge-promote — governs
//     activation, the wire can never activate a row), source='knowledge-sync',
//     origin_hub recorded in origin_system. Local rows are never displaced:
//     a topic that already exists → skipped as dupe.
//   metrics → sync_metrics (origin_hub, dim, dim_key) upserts — idempotent
//     by key; re-sent snapshots replace in place.
//
// Guards: the W264 perimeter (host allowlist + x-klh-write-token for
// non-GET) runs in fleet-board.ts BEFORE this handler — same posture as the
// lane-observations ingest. Strict shape validation; 64 KiB body cap.
import type { Database } from "bun:sqlite";
import { openKnowledgeDb } from "../lib/govdb.ts";
import { makeStamp } from "../lib/confidence.ts";
import { json } from "./helpers.ts";
import { SYNCABLE_FACT, MAX_FACT_VALUE } from "../lib/knowledge-sync.ts";

let kdbSingleton: Database | null = null;
export function boardKnowledgeDb(): Database {
	if (!kdbSingleton) kdbSingleton = openKnowledgeDb();
	return kdbSingleton;
}

/** Self-healing CREATE (the openGovernorDb doctrine) for the metrics table. */
export function ensureSyncTables(kdb: Database): void {
	kdb.run(
		"CREATE TABLE IF NOT EXISTS sync_metrics (origin_hub TEXT NOT NULL, dim TEXT NOT NULL, dim_key TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (origin_hub, dim, dim_key))",
	);
}

export interface IngestCounters {
	facts: { landed: number; dupes: number; rejected: number };
	metrics: number;
}

function identity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!!value.trim() &&
		value.length <= 128 &&
		!["all", "unknown"].includes(value) &&
		![...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function safeMetricString(v: unknown, max = 128): v is string {
	return (
		typeof v === "string" &&
		v.length > 0 &&
		v.length <= max &&
		[...v].every((c) => {
			const code = c.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
	);
}

/** One syncable metrics row: key charset-checked, numbers finite. */
function validStatsRow(row: unknown): boolean {
	if (!row || typeof row !== "object" || Array.isArray(row)) return false;
	const r = row as Record<string, unknown>;
	if (!safeMetricString(r.key) || !isFiniteNumber(r.sessions)) return false;
	if (!isFiniteNumber(r.tokens) || !isFiniteNumber(r.costUsd)) return false;
	for (const k of Object.keys(r)) {
		if (!["key", "sessions", "tokens", "costUsd"].includes(k)) return false;
	}
	return true;
}

const SESSION_FIELDS: string[] = [
	"sessionId",
	"tool",
	"model",
	"reasoningEffort",
	"startedAt",
	"endedAt",
	"durationMs",
	"messageCount",
	"inputTokens",
	"outputTokens",
	"reasoningTokens",
	"peakContextTokens",
	"contextWindowTokens",
	"costUsd",
];
const SESSION_STRINGS = [
	"tool",
	"model",
	"reasoningEffort",
	"startedAt",
	"endedAt",
];
const SESSION_NUMBERS = [
	"durationMs",
	"messageCount",
	"inputTokens",
	"outputTokens",
	"reasoningTokens",
	"peakContextTokens",
	"contextWindowTokens",
	"costUsd",
];

function validSessionRow(row: unknown): boolean {
	if (!row || typeof row !== "object" || Array.isArray(row)) return false;
	const r = row as Record<string, unknown>;
	if (!/^[0-9a-f]{16}$/.test(String(r.sessionId))) return false;
	for (const k of Object.keys(r)) {
		if (!SESSION_FIELDS.includes(k)) return false;
	}
	for (const k of SESSION_STRINGS) {
		if (r[k] !== null && !safeMetricString(r[k])) return false;
	}
	for (const k of SESSION_NUMBERS) {
		if (r[k] !== null && !isFiniteNumber(r[k])) return false;
	}
	return true;
}

function validFactRow(row: unknown): { ok: boolean; reason: string | null } {
	if (!row || typeof row !== "object" || Array.isArray(row))
		return { ok: false, reason: "not an object" };
	const f = row as Record<string, unknown>;
	if (typeof f.key !== "string" || !SYNCABLE_FACT.test(f.key))
		return { ok: false, reason: "key outside the syncable vocabulary" };
	if (typeof f.value !== "string" || f.value.length === 0)
		return { ok: false, reason: "empty value" };
	if (f.value.length > MAX_FACT_VALUE)
		return { ok: false, reason: "value too large" };
	if (
		f.source !== undefined &&
		f.source !== null &&
		typeof f.source !== "string"
	)
		return { ok: false, reason: "bad source" };
	if (!isFiniteNumber(f.version) || !isFiniteNumber(f.ts))
		return { ok: false, reason: "bad version/ts" };
	return { ok: true, reason: null };
}

/** Landing core, db-injected for tests. Facts land as CANDIDATE rows
 *  (unverified trust marker; the hub's W142 promote gate governs
 *  activation). Metrics upsert by (origin_hub, dim, dim_key). */
export function landKnowledgeIngest(
	kdb: Database,
	input: unknown,
): { ok: boolean; error?: string; counts?: IngestCounters } {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return { ok: false, error: "payload must be an object" };
	const p = input as Record<string, unknown>;
	if (!identity(p.originHub)) return { ok: false, error: "bad originHub" };
	ensureSyncTables(kdb);
	const counts: IngestCounters = {
		facts: { landed: 0, dupes: 0, rejected: 0 },
		metrics: 0,
	};
	const facts = Array.isArray(p.facts) ? p.facts : [];
	if (facts.length > 50) return { ok: false, error: "too many facts (max 50)" };
	// facts loop (W944)
	for (const raw of facts) {
		const v = validFactRow(raw);
		if (!v.ok) {
			counts.facts.rejected++;
			continue;
		}
		const f = raw as Record<string, unknown>;
		const topic = f.key as string;
		const exists = kdb
			.query("SELECT 1 FROM knowledge WHERE topic = ?")
			.get(topic);
		if (exists) {
			counts.facts.dupes++;
			continue;
		}
		const now = Date.now();
		// W953: remote facts arrive machine-raw on this hub — stamped 0.3,
		// mechanical:knowledge-sync; the origin hub's grade does not travel.
		const stamp = makeStamp({
			value: 0.3,
			setter: "mechanical:knowledge-sync",
			evidence: `hub:${p.originHub}`,
		});
		kdb.run(
			"INSERT INTO knowledge (ts, topic, fact, confidence, origin_kind, origin_system, origin_sid, contributors, source, state, confidence_stamp) VALUES (?, ?, ?, ?, 'remote-fact', ?, ?, ?, 'knowledge-sync', 'candidate', ?)",
			now,
			topic,
			f.value,
			stamp.value,
			p.originHub,
			p.originHub,
			JSON.stringify([{ sid: p.originHub, ts: now, what: "knowledge-sync" }]),
			JSON.stringify(stamp),
		);
		counts.facts.landed++;
	}
	// metrics upserts: per-dim validation then INSERT OR REPLACE
	const m = (p.metrics ?? {}) as Record<string, unknown>;
	for (const [field, dim] of [
		["days", "day"],
		["tools", "tool"],
		["models", "model"],
		["sessions", "session"],
	] as const) {
		const rows = m[field];
		if (rows === undefined) continue;
		if (!Array.isArray(rows))
			return { ok: false, error: `${field} must be a list` };
		if (rows.length > 2500)
			return { ok: false, error: `${field} too long (max 2500)` };
		for (const row of rows) {
			if (!validMetricsRow(dim as Dim, row))
				return { ok: false, error: `invalid ${field} row` };
		}
		const ts = Date.now();
		for (const row of rows) {
			kdb.run(
				"INSERT OR REPLACE INTO sync_metrics (origin_hub, dim, dim_key, payload, ts) VALUES (?, ?, ?, ?, ?)",
				p.originHub,
				dim,
				(row as Record<string, unknown>).key ??
					(row as Record<string, unknown>).sessionId,
				JSON.stringify(row),
				ts,
			);
		}
		counts.metrics += rows.length;
	}
	// route handler lands below (W944)
	return { ok: true, counts };
}

export async function handleKnowledgeIngest(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname !== "/api/knowledge-ingest") return null;
	if (req.method === "GET" || req.method === "HEAD") return jsonIngestSummary();
	if (req.method !== "POST")
		return new Response(null, {
			status: 405,
			headers: { Allow: "GET, HEAD, POST" },
		});
	// POST body (W944): strict content-type, 64 KiB cap, JSON parse, land
	const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim();
	if (ct !== "application/json")
		return json(
			{ ok: false, error: "content-type must be application/json" },
			415,
		);
	try {
		const reader = req.body?.getReader();
		if (!reader) return json({ ok: false, error: "body required" }, 400);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 65_536) {
				await reader.cancel();
				return json({ ok: false, error: "body exceeds 64 KiB" }, 413);
			}
			chunks.push(value);
		}
		reader.releaseLock();
		return await landFromRequest(chunks);
	} catch {
		return json({ ok: false, error: "Invalid ingest JSON" }, 400);
	}
}

async function landFromRequest(chunks: Uint8Array[]): Promise<Response> {
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const result = landKnowledgeIngest(boardKnowledgeDb(), input);
	return json(result, result.ok ? 200 : 400);
}

const DIMS = ["day", "tool", "model", "session"] as const;
type Dim = (typeof DIMS)[number];

function validMetricsRow(dim: Dim, row: unknown): boolean {
	if (dim === "session") return validSessionRow(row);
	return validStatsRow(row);
}

/** GET: the landed ingest summary (counts per hub). */
export function jsonIngestSummary(): Response {
	const kdb = boardKnowledgeDb();
	ensureSyncTables(kdb);
	const facts = kdb
		.query(
			"SELECT COUNT(*) AS n FROM knowledge WHERE source = 'knowledge-sync'",
		)
		.get() as { n: number };
	const metrics = kdb.query("SELECT COUNT(*) AS n FROM sync_metrics").get() as {
		n: number;
	};
	const hubs = kdb
		.query(
			"SELECT DISTINCT origin_system FROM knowledge WHERE source = 'knowledge-sync'",
		)
		.all() as { origin_system: string | null }[];
	return json({
		ok: true,
		facts: facts.n,
		metrics: metrics.n,
		hubs: hubs.map((h) => h.origin_system),
	});
}
