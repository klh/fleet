// src/diet.ts — W207 loop-level trajectory pruning (the AgentDiet analog,
// W121 lever #5): every loop turn replays the whole trajectory; old tool
// results are the measured bulk (63% of trajectory tokens, AgentDiet
// arXiv:2509.23586). The gateway rewrites stale tool results past a
// keep-window into one-line tombstones. Deterministic, conservative: recent
// turns survive verbatim, sub-minimum results survive, non-tool text is
// never touched. Gateway-ENFORCED by design — AgentDiet's negative result is
// that agents under-call erase tools, so self-managed cleanup fails; the
// pruning must be imposed by the loop, not requested by the agent. Elided
// raw content stays one GET away by rid (/diet/<rid>, the pipeline_in
// precedent). Policy-gated DEFAULT-OFF (W137 economics: a prefix rewrite
// costs cache re-reads — it must prove ROI before an operator flips it on).
import { Database } from "bun:sqlite";
import type { AidsPolicy } from "./policy.ts";
import type { Dialect } from "./upstreams.ts";

type AnyRec = Record<string, unknown>;

/** Write-time engine stamp, stored per row (the condense_version law). */
export const DIET_VERSION = "buckle-diet/1";

/** The default pass knobs (routing-policy.yaml `aids.prune` overrides). */
export const DIET_DEFAULTS: PruneOpts = {
	/** Most recent tool exchanges kept verbatim. */
	keepTurns: 3,
	/** Results below this size survive untouched. */
	minResultBytes: 2048,
	/** Per-row raw store cap; larger raws store truncated + flagged. */
	maxStoreBytes: 65536,
};

export interface PruneOpts {
	keepTurns: number;
	minResultBytes: number;
	maxStoreBytes: number;
}

/** One elided step: the store row shape (the raw one GET away). */
export interface PrunedStep {
	/** Position among the request's tool exchanges (0-based, replay order). */
	seq: number;
	tool: string;
	/** 1-based exchanges from the newest (1 = the newest tool result). */
	age: number;
	/** Byte size of the elided content. */
	bytes: number;
	/** The elided content (string, or JSON of block arrays) — truncated to
	 *  maxStoreBytes with raw_truncated set. */
	raw: string;
	raw_truncated: boolean;
}

export interface PruneOutcome {
	/** The pruned body (=== input when nothing fired — no copy, no touch). */
	body: AnyRec;
	events: PrunedStep[];
	bytes_before: number;
	bytes_after: 0 | number;
}

// ─── the pure pass ──────────────────────────────────────────────────────────

/** A located tool exchange: message index + block index (−1 = the openai
 *  tool message itself is the carrier). */
interface Exchange {
	seq: number;
	mi: number;
	bi: number;
	tool: string;
	content: string;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content === null || content === undefined) return "";
	try {
		return JSON.stringify(content);
	} catch {
		return "";
	}
}

function asRec(v: unknown): AnyRec | null {
	return v !== null && typeof v === "object" ? (v as AnyRec) : null;
}

/** The tombstone: the only thing the model sees where content used to be. */
function tombstone(tool: string, bytes: number, age: number): string {
	return `[buckle diet: elided ${tool} result (~${(bytes / 1024).toFixed(1)}KB, ${age} tool-turns old)]`;
}

function NONE(body: AnyRec): PruneOutcome {
	return { body, events: [], bytes_before: 0, bytes_after: 0 };
}

/** The deterministic pass over both dialects. Purity: the input body is
 *  never mutated — a change yields a fresh body object; no change returns
 *  the SAME reference (callers can === to detect touch). Deterministic:
 *  same body + opts → same output, always. */
export function pruneTrajectory(
	body: AnyRec,
	dialect: Dialect,
	opts: PruneOpts = DIET_DEFAULTS,
): PruneOutcome {
	const messages = body.messages;
	if (!Array.isArray(messages)) return NONE(body);
	const exchanges = collectExchanges(dialect, messages);
	if (exchanges.length === 0) return NONE(body);
	const total = exchanges.length;
	const doomed = exchanges.filter(
		(e) =>
			total - e.seq > opts.keepTurns &&
			Buffer.byteLength(e.content) >= opts.minResultBytes,
	);
	if (doomed.length === 0) return NONE(body);

	// Copy-on-write: only messages that actually change get cloned.
	const newMessages = [...messages];
	let bytesBefore = 0;
	let bytesAfter = 0;
	const events: PrunedStep[] = [];
	for (const e of doomed) {
		const age = total - e.seq;
		const bytes = Buffer.byteLength(e.content);
		const truncated = bytes > opts.maxStoreBytes;
		events.push({
			seq: e.seq,
			tool: e.tool,
			age,
			bytes,
			raw: truncated ? e.content.slice(0, opts.maxStoreBytes) : e.content,
			raw_truncated: truncated,
		});
		const tomb = tombstone(e.tool, bytes, age);
		bytesBefore += bytes;
		bytesAfter += Buffer.byteLength(tomb);
		const rec = asRec(newMessages[e.mi]);
		if (!rec) continue;
		if (dialect === "anthropic") {
			if (newMessages[e.mi] === messages[e.mi])
				newMessages[e.mi] = {
					...rec,
					content: [...(rec.content as unknown[])],
				};
			const fresh = asRec(newMessages[e.mi]);
			const arr = fresh?.content as unknown[];
			const block = asRec(arr[e.bi]);
			if (block) arr[e.bi] = { ...block, content: tomb };
		} else {
			newMessages[e.mi] = { ...rec, content: tomb };
		}
	}
	return {
		body: { ...body, messages: newMessages },
		events,
		bytes_before: bytesBefore,
		bytes_after: bytesAfter,
	};
}

/** Walk the messages once per dialect; the walk never mutates anything. */
function collectExchanges(dialect: Dialect, messages: unknown[]): Exchange[] {
	const out: Exchange[] = [];
	if (dialect === "anthropic") {
		// tool_use id → name from every assistant message; the id is the
		// pairing contract (results may sit in later user messages).
		const names = new Map<string, string>();
		for (const m of messages) {
			const rec = asRec(m);
			if (rec?.role !== "assistant" || !Array.isArray(rec.content)) continue;
			for (const b of rec.content) {
				const block = asRec(b);
				if (block?.type === "tool_use" && typeof block.id === "string")
					names.set(
						block.id,
						typeof block.name === "string" ? block.name : "unknown",
					);
			}
		}
		messages.forEach((m, mi) => {
			const rec = asRec(m);
			if (rec?.role !== "user" || !Array.isArray(rec.content)) return;
			(rec.content as unknown[]).forEach((b, bi) => {
				const block = asRec(b);
				if (block?.type !== "tool_result") return;
				const id =
					typeof block.tool_use_id === "string" ? block.tool_use_id : "";
				out.push({
					seq: out.length,
					mi,
					bi,
					tool: names.get(id) ?? "unknown",
					content: contentText(block.content),
				});
			});
		});
		return out;
	}
	// openai: names from assistant tool_calls; carriers = role:"tool" msgs.
	const names = new Map<string, string>();
	for (const m of messages) {
		const rec = asRec(m);
		const calls = rec?.tool_calls;
		if (!Array.isArray(calls)) continue;
		for (const c of calls) {
			const call = asRec(c);
			const fn = asRec(call?.function);
			if (call && typeof call.id === "string" && fn)
				names.set(call.id, typeof fn.name === "string" ? fn.name : "unknown");
		}
	}
	messages.forEach((m, mi) => {
		const rec = asRec(m);
		if (rec?.role !== "tool") return;
		const id = typeof rec.tool_call_id === "string" ? rec.tool_call_id : "";
		out.push({
			seq: out.length,
			mi,
			bi: -1,
			tool: names.get(id) ?? "unknown",
			content: contentText(rec.content),
		});
	});
	return out;
}

// ─── policy mapping ─────────────────────────────────────────────────────────

/** The routing-policy.yaml `aids.prune` block → pass knobs. */
export function pruneOptsOf(policy: AidsPolicy): PruneOpts {
	const p = policy.prune;
	return {
		keepTurns: p?.keep_turns ?? DIET_DEFAULTS.keepTurns,
		minResultBytes: p?.min_bytes ?? DIET_DEFAULTS.minResultBytes,
		maxStoreBytes: p?.max_store_bytes ?? DIET_DEFAULTS.maxStoreBytes,
	};
}

// ─── the rid-keyed sidestore ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diet_steps (
  rid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  dialect TEXT NOT NULL,
  tool TEXT NOT NULL,
  age INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  raw TEXT NOT NULL,
  raw_truncated INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  PRIMARY KEY (rid, seq)
);
`;

/** Bounded at 200 rids (newest win) — the pipeline_in 500-row precedent,
 *  rid-shaped: one pruned request replays many rows. */
const MAX_RIDS = 200;

/** The raw stays one GET away: rid-keyed rows in the shared buckle db (own
 *  WAL connection — the Ledger/AidsLedger/CondenseStore precedent). */
export class DietStore {
	private readonly db: Database;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
	}

	put(rid: string, dialect: string, steps: PrunedStep[]): void {
		const ts = this.now().getTime();
		for (const s of steps) {
			this.db
				.query(
					`INSERT INTO diet_steps
	         (rid, seq, ts, dialect, tool, age, bytes, raw, raw_truncated, version)
	         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	       ON CONFLICT(rid, seq) DO UPDATE SET
	         ts = excluded.ts, dialect = excluded.dialect, tool = excluded.tool,
	         age = excluded.age, bytes = excluded.bytes, raw = excluded.raw,
	         raw_truncated = excluded.raw_truncated, version = excluded.version`,
				)
				.run(
					rid,
					s.seq,
					ts,
					dialect,
					s.tool,
					s.age,
					s.bytes,
					s.raw,
					s.raw_truncated ? 1 : 0,
					DIET_VERSION,
				);
		}
		this.db
			.query(
				`DELETE FROM diet_steps WHERE rid NOT IN (
	         SELECT rid FROM diet_steps GROUP BY rid ORDER BY MAX(ts) DESC, rid DESC LIMIT ?
	       )`,
			)
			.run(MAX_RIDS);
	}

	/** All elided steps for one rid, replay order; null on a miss. */
	get(rid: string): Array<{
		seq: number;
		ts: number;
		dialect: string;
		tool: string;
		age: number;
		bytes: number;
		raw: string;
		raw_truncated: number;
		version: string | null;
	}> | null {
		const rows = this.db
			.query(
				"SELECT seq, ts, dialect, tool, age, bytes, raw, raw_truncated, version FROM diet_steps WHERE rid = ? ORDER BY seq",
			)
			.all(rid) as Array<{
			seq: number;
			ts: number;
			dialect: string;
			tool: string;
			age: number;
			bytes: number;
			raw: string;
			raw_truncated: number;
			version: string | null;
		}>;
		return rows.length > 0 ? rows : null;
	}

	/** Newest rids first (the board's list face). */
	list(limit = 25): Array<{
		rid: string;
		ts: number;
		dialect: string;
		steps: number;
		elided_bytes: number;
	}> {
		return this.db
			.query(
				`SELECT rid, MAX(ts) AS ts, dialect, COUNT(*) AS steps, SUM(bytes) AS elided_bytes
	         FROM diet_steps GROUP BY rid ORDER BY ts DESC, rid DESC LIMIT ?`,
			)
			.all(Math.min(Math.max(1, limit), 100)) as Array<{
			rid: string;
			ts: number;
			dialect: string;
			steps: number;
			elided_bytes: number;
		}>;
	}

	close(): void {
		this.db.close();
	}
}

// ─── the routes ──────────────────────────────────────────────────────────────

/** GET /diet?limit=N → newest pruned requests (the board's list face).
 *  GET /diet/<rid> → the elided steps, raw content included (one GET away).
 *  Bare deps (no diet store) 404 honestly — the AppDeps contract. */
export async function dietRoutes(
	deps: { diet?: DietStore },
	req: Request,
	path: string,
): Promise<Response | null> {
	if (!path.startsWith("/diet")) return null;
	if (!deps.diet) return problem404(`no route: ${req.method} ${path}`);
	if (path === "/diet" && req.method === "GET") {
		const limit = Number(new URL(req.url).searchParams.get("limit") ?? "25");
		return Response.json({ ok: true, rows: deps.diet.list(limit) });
	}
	const rid = path.slice("/diet/".length);
	if (rid.length > 0 && req.method === "GET") {
		const rows = deps.diet.get(rid);
		if (!rows) return problem404(`no diet rows for rid ${rid}`);
		return Response.json({ ok: true, rid, rows });
	}
	return null;
}

function problem404(why: string): Response {
	return Response.json(
		{
			type: "/problems/not_found",
			title: "Not Found",
			status: 404,
			detail: why,
			code: "buckle.no_route",
		},
		{ status: 404, headers: { "content-type": "application/problem+json" } },
	);
}
