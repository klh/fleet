// hooks/lib/knowledge-ports.ts — W91 #9: the knowledge layer's ports. The
// worker loop consumes INTERFACES, never concrete tech, so an enterprise
// deployment can swap the store (Azure Blob / Postgres / Service Bus) or the
// distill client without touching the loop. Production inference enters
// Buckle; remote adapters are deliberately not written here.
//
//   KnowledgeStore — queue semantics + candidate storage + search. The FTS5
//     specifics live in the SQLite adapter; a remote store implements search
//     with its own engine. Remote manners: batch claim/complete, never
//     chatty per-row round trips.
//   DistillClient — payload → candidate JSON (knowledgeworker.md prepended
//     here, per directive #6). The default uses Buckle's local-swarm group.
//
// Config seam: a plain switch at daemon startup (env), no plugin framework.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeHit } from "./knowledge.ts";
import { openKnowledgeDb } from "./govdb.ts";
import type { DecayOpts } from "./knowledge-curate.ts";
import { knowledgeBuckleRoute } from "./knowledge-buckle.ts";

export type { KnowledgeHit };

export interface KnowledgeJob {
	id: number;
	source: string;
	payload: string;
	attempts: number;
	domain: string | null;
	area: string | null;
	// W100: the producer-declared provenance (normalized at enqueue) — claim()
	// surfaces it INSTEAD of the raw code_origin hint so the substitution
	// gate's fallback writes a resolvable ref, not "path — explanation" prose.
	codeOrigin: string | null;
	originSid: string | null;
	sourceRef: string | null;
	// W100: enqueue-time sha256 of the source_ref FILE (producer had repo
	// access; the distiller only sees the payload) — never the payload hash.
	// "" when the producer stored NULL (ref unresolvable there); upsert()
	// lands "" as NULL so the trust marker stays honest.
	sourceHash: string;
	/** W159: the queue row's settled hub_eligible (NULL = unsettled) —
	 *  inherited by distilled rows so feed timing cannot orphan the sort. */
	hubEligible: 0 | 1 | null;
}

export interface KnowledgeUpsert {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	sourceRef: string | null;
	// W100: the enqueue-time FILE hash from the queue (claim() maps NULL to
	// ""). upsert() lands ""/NULL as a NULL row hash — never a doomed value.
	sourceHash: string | null;
	originSid: string | null;
	/** W159 provenance sort: stamp distilled rows from the queue row's
	 *  settled flag (inheritance at distill; the settle backfills the rest). */
	hubEligible?: 0 | 1 | null;
	supersedesId: number | null;
}

/** W246 near-dup propose-dispose: one firing of the ingest dedupe gate. The
 *  skip stands (older kept); the proposal records the skipped candidate (X)
 *  against the near-dup row (Y) so a human can dispose — retire Y
 *  superseded-by X if X is the correction. Append-only: ledger + one event. */
export interface NearDupProposal {
	/** the existing near-dup row the proposal would retire */
	y: number;
	yTopic: string;
	/** the skipped candidate's topic/fact (already secret-redacted) */
	xTopic: string;
	xFact: string;
	/** the disposal a human would execute on confirmation */
	action: string;
}

export interface KnowledgeSearchFilters {
	query: string;
	limit?: number;
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
}

// W381 (from parked/W208): one knowledge_proposals row joined with its
// knowledge row — the human dispose surface reads these.
export interface KnowledgeProposalView {
	id: number;
	knowledgeId: number;
	state: string;
	score: number;
	ageDays: number;
	reason: string;
	ts: number;
	decidedBy: string | null;
	decidedAt: number | null;
	topic: string;
	fact: string;
}

// W381 (from parked/W208): one decay sweep's outcome — proposed are the
// drafts written open.
export interface DecaySweep {
	checked: number;
	proposed: ProposalDraft[];
	refreshed: number;
	stale: number;
}

export interface KnowledgeStore {
	// queue semantics (directive #8 shape stays a worker-loop concern; the
	// store only guarantees claim/complete/fail)
	peekNext(): Promise<{ id: number } | null>;
	claim(id: number): Promise<KnowledgeJob | null>;
	complete(
		id: number,
		ledger: {
			written: number[];
			skipped: string[];
			proposals?: NearDupProposal[];
		},
		domain: string | null,
		by: string | null,
	): Promise<void>;
	fail(id: number, err: string, poison: boolean): Promise<void>;
	// storage + retrieval
	upsert(row: KnowledgeUpsert): Promise<number>;
	dedupeCheck(cand: {
		topic: string;
		fact: string;
	}): Promise<{ id: number; topic: string; fact: string } | null>;
	search(filters: KnowledgeSearchFilters): Promise<KnowledgeHit[]>;
	emitLanded(
		domain: string | null,
		written: number[],
		queueId: number,
		by: string | null,
	): Promise<void>;
	// W246: one supersession-proposal event row per near-dup firing
	proposeSupersession(
		p: NearDupProposal,
		queueId: number,
		by: string | null,
	): Promise<void>;
	recoverOrphans(olderThanMs: number): Promise<void>;
	queuedCount(): Promise<number>;
	// lifecycle (human/merge-gated; mechanical micro-updates)
	promote(id: number): Promise<boolean>;
	retire(id: number, supersededBy: number | null): Promise<boolean>;
	note(id: number, sid: string, what: string): Promise<number>;
	// W836 audit trust schema: grade stamps {rating, evidence, researched_at}
	// on a row (audit-lane provenance note rides along); graveyard buries a
	// rejected/integrity-flagged row with its reason — NEVER a delete, and
	// recall ranking excludes the state.
	grade(
		id: number,
		fields: {
			rating?: string | null;
			evidence?: string | null;
			researchedAt?: number | null;
		},
		by?: string,
	): Promise<boolean>;
	graveyard(id: number, reason: string, by?: string): Promise<boolean>;
	verifyRows(
		id: number | null,
	): Promise<
		{ id: number; topic: string; sourceRef: string; sourceHash: string }[]
	>;
	// W103 curation: flag rows failing the substitution test for HUMAN review.
	// Rows stay in place, state untouched — a contributors note records the
	// verdict (append-only, NO updated_at bump: flagging is not freshness).
	curate(opts: { repoRoot: string; by?: string }): Promise<{
		checked: number;
		flagged: {
			id: number;
			topic: string;
			doc: string;
			coverage: number;
		}[];
	}>;
	// W166: the W159 settle's provenance sort rides the PORT — the settle's
	// knowledge writes must go through knowledge.db, never openGovernorDb.
	settleHubEligible(
		sid: string,
		flag: 0 | 1,
	): Promise<{ queueMarked: number; rowsBackfilled: number }>;
	// W166 (design §4): FTS5 segment merge after every job that wrote rows —
	// measured 70 ms per run, ~5% read-latency recovery after churn.
	optimize(): Promise<void>;
	// W244 — parser-change reprocess checkpoint. `cur` = active distill-prompt
	// hash; done rows processed under an older parser re-enqueue EXACTLY ONCE.
	// apply=false is a read-only dry-run (would-counts only, no writes).
	reprocessCheck(cur: string, apply: boolean): Promise<ReprocessReport>;
	// W381 (from parked/W208) curation engine: recency decay → propose →
	// human dispose. The sweep only proposes (one open proposal per row;
	// recovered rows auto-close 'stale'); disposeProposal is the only path
	// to a row mutation.
	proposeDecay(opts?: DecayOpts): Promise<DecaySweep>;
	listProposals(state?: string): Promise<KnowledgeProposalView[]>;
	disposeProposal(
		id: number,
		decision: "approve" | "dismiss",
		opts?: { by?: string; note?: string; supersededBy?: number | null },
	): Promise<{ ok: boolean; retired: boolean }>;
}

// W244 — outcome of one reprocessCheck pass. requeued/marked are did-counts
// when applied, would-counts on a dry-run; checkpoint = the stored hash the
// pass compared against (null = no checkpoint yet); advanced = the checkpoint
// moved this pass.
export interface ReprocessReport {
	current: string;
	checkpoint: string | null;
	advanced: boolean;
	requeued: number;
	marked: number;
	/** legacy rows whose payload was cleared pre-W244 — marked so they never
	 *  re-fire, honestly NOT re-ingestable (source text is gone). */
	skippedNoPayload: number;
}

export interface DistillClient {
	distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<
		{
			topic: string;
			fact: string;
			confidence: number;
			domain: string | null;
			area: string | null;
			originKind: string | null;
			originSystem: string | null;
			supersedesId: number | null;
		}[]
	>;
}

// ─── local adapter: knowledge.db (SQLite/WAL) — the SqliteKnowledgeStore
// class lives in knowledge-store-sqlite.ts (W1238.6.6 decompose); the
// import+re-export keeps the module face (and every import site) byte-stable
// while makeStore below still binds the name.
import { SqliteKnowledgeStore } from "./knowledge-store-sqlite.ts";
export { SqliteKnowledgeStore };

// ─── distill support: strict JSON parse + canon clamps (#7) ───
export interface DistillItem {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	supersedesId: number | null;
	sourceRef: string | null;
}

// tolerate fences/prose around the JSON array; validate + clamp each item
export function parseDistill(raw: string): DistillItem[] {
	let t = raw.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence) t = fence[1];
	const l = t.indexOf("[");
	const r = t.lastIndexOf("]");
	if (l === -1 || r <= l)
		throw new Error(`no JSON array in distill output: ${t.slice(0, 80)}`);
	const arr = JSON.parse(t.slice(l, r + 1)) as unknown[];
	return arr
		.map(asItem)
		.filter((x): x is DistillItem => x !== null)
		.slice(0, 12);
}

// W91 #9/#7: canon clamps — the distill contract caps topic/fact; raw source
// text never enters the table (source_ref + source_hash point back instead)
function asItem(x: unknown): DistillItem | null {
	if (!x || typeof x !== "object") return null;
	const o = x as Record<string, unknown>;
	const t = typeof o.topic === "string" ? o.topic.trim() : "";
	const f = typeof o.fact === "string" ? o.fact.trim() : "";
	if (!t || !f) return null;
	const s = (v: unknown): string | null =>
		typeof v === "string" && v.trim() ? v.trim() : null;
	const conf =
		typeof o.confidence === "number" && Number.isFinite(o.confidence)
			? Math.min(1, Math.max(0, o.confidence))
			: 0.5;
	return {
		topic: t.slice(0, 80),
		fact: f.slice(0, 400),
		confidence: conf,
		domain: s(o.domain),
		area: s(o.area),
		originKind: s(o.origin_kind)?.toLowerCase() ?? null,
		originSystem: s(o.origin_system),
		// extraction only: the source must DECLARE the correction; the model
		// never judges. Clamped to a real row at insert (store.upsert).
		supersedesId:
			typeof o.supersedes_id === "number" && Number.isInteger(o.supersedes_id)
				? o.supersedes_id
				: null,
		// W103 substitution contract: the model may emit a POINTER ref for
		// doc-covered facts; the worker only honors it when the file resolves
		sourceRef: s(o.source_ref),
	};
}

// W244: the prompt file resolves per request — KNOWLEDGE_PROMPT_FILE is the
// config-over-code override (enterprise gateway, tests); unset → the shipped
// hooks/knowledgeworker.md.
const PROMPT_FILE = (): string =>
	process.env.KNOWLEDGE_PROMPT_FILE ??
	join(import.meta.dir, "..", "knowledgeworker.md");

// knowledgeworker.md: config-over-code — re-read at REQUEST time so prompt
// edits apply to the next queued job without a restart (#6)
export function systemPrompt(): string {
	try {
		return readFileSync(PROMPT_FILE(), "utf8");
	} catch {
		return "";
	}
}

// missing prompt file → minimal inline fallback, never a dead worker
const FALLBACK_PROMPT =
	"You are an impartial indexer for a fleet knowledge store. You do not evaluate truth, quality, or usefulness — you describe, condense, link, and timestamp. Return ONLY a JSON array. Each element: {topic, fact, confidence 0..1, domain, area, origin_kind (lesson|incident|decision|study|fact), origin_system, supersedes_id (only when the source text EXPLICITLY declares it replaces/corrects a row, else null), source_ref (REQUIRED when the payload names a doc path: the repo-relative path of that exact doc, else null)}. Never copy credentials into facts — redact as [REDACTED] or reject. Substitution contract: never restate what one file/doc already teaches — pointer-ize (source_ref + non-obvious residue) or reject. Corrections create a new row via supersedes_id; history is append-only.";

// W244 — the ACTIVE prompt is what a distill request sends right now (both
// clients fall back identically when the file is absent); its sha256 is the
// parser version the reprocess checkpoint compares queue rows against.
export const activePrompt = (): string => systemPrompt() || FALLBACK_PROMPT;
export const currentPromptHash = (): string =>
	createHash("sha256").update(activePrompt()).digest("hex");

async function defaultModel(url: string, key?: string): Promise<string> {
	try {
		const r = await fetch(url.replace(/\/chat\/completions$/, "/models"), {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		const j = (await r.json()) as { data?: { id: string }[] };
		return j.data?.[0]?.id ?? "local";
	} catch {
		return "local";
	}
}

// W91 #9: explicit adapter retained for direct unit use. The production
// factory below rejects its legacy endpoint override so inference enters Buckle.
export class LocalLlmDistillClient implements DistillClient {
	constructor(
		private url: string,
		private key?: string,
	) {}

	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const model =
			process.env.INGEST_LLM_MODEL ?? (await defaultModel(this.url, this.key));
		const hintsLine = [
			hints.domain ? `domain=${hints.domain}` : "domain=null",
			hints.area ? `area=${hints.area}` : "area=null",
			hints.codeOrigin ? `code_origin=${hints.codeOrigin}` : "code_origin=null",
		].join(", ");
		return this.chat(payload, hintsLine, model, hints.originSid);
	}

	private async chat(
		payload: string,
		hintsLine: string,
		model: string,
		originSid: string | null,
	): Promise<DistillItem[]> {
		const sys = activePrompt();
		const user = `payload:\n${payload}\n\nenqueue hints (authoritative over your guesses when set): ${hintsLine}${originSid ? `\norigin_sid: ${originSid}` : ""}`;
		const r = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: user },
				],
				temperature: 0.2,
				max_tokens: 1600,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (!r.ok)
			throw new Error(
				`LLM ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
			);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return parseDistill(j.choices?.[0]?.message?.content ?? "");
	}
}

export class BuckleDistillClient implements DistillClient {
	// Buckle accepts the W96 hint and routes local-swarm among Belt specialists.
	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const { front, token } = knowledgeBuckleRoute();
		const sys = activePrompt();
		const user = `payload:\n${payload}\n\nenqueue hints: domain=${hints.domain ?? "null"}, area=${hints.area ?? "null"}, code_origin=${hints.codeOrigin ?? "null"}`;
		return this.route(user, sys, front, token);
	}

	private async route(
		user: string,
		sys: string,
		front: URL,
		token: string,
	): Promise<DistillItem[]> {
		const r = await fetch(new URL("/v1/chat/completions", front), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				"x-belt-hint": "prefer local distill reasoning",
			},
			body: JSON.stringify({
				model: "local-swarm",
				max_tokens: 1600,
				temperature: 0.2,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!r.ok)
			throw new Error(
				`Buckle distill route ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
			);
		const j = (await r.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		return parseDistill(j.choices?.[0]?.message?.content ?? "");
	}
}

// ─── config seam: a plain switch at daemon startup, no plugin framework ───
export function makeStore(): KnowledgeStore {
	const url = process.env.KNOWLEDGE_STORE_URL;
	if (url)
		throw new Error(
			`no remote knowledge-store adapter in this build (KNOWLEDGE_STORE_URL=${url}) — the local SQLite store is the only implementation; the port is the seam`,
		);
	return new SqliteKnowledgeStore(openKnowledgeDb());
}

export function makeDistillClient(): DistillClient {
	if (process.env.INGEST_LLM_URL)
		throw new Error(
			"INGEST_LLM_URL bypasses Buckle; configure SUSPENDERS_BUCKLE_URL and scoped SUSPENDERS_BUCKLE_TOKEN instead",
		);
	// Fail before the worker claims queue rows if its proxy credential is absent.
	knowledgeBuckleRoute();
	return new BuckleDistillClient();
}

// producer seam (#9b): enqueue through the port, never INSERT directly — a
// producer in another repo/machine keeps working when the store moves
export async function enqueueKnowledge(job: {
	source: string;
	payload: string;
	domain?: string | null;
	area?: string | null;
	codeOrigin?: string | null;
	originSid?: string | null;
	// W100: declared provenance ref — explanatory suffixes are normalized out
	// and the named FILE is hashed at ENQUEUE time (the producer has repo
	// access; the distiller only sees the payload). Defaults to codeOrigin.
	sourceRef?: string | null;
	// repo root the ref resolves against — default KNOWLEDGE_DOCS_ROOT (W103),
	// then KNOWLEDGE_REPO_ROOT, then the producer's cwd
	docsRoot?: string;
}): Promise<number> {
	// W100: hash the declared source FILE here — the producer has repo access;
	// the distiller never sees the filesystem.
	const ref = normalizeSourceRef(job.sourceRef || job.codeOrigin || "");
	const root =
		job.docsRoot ??
		process.env.KNOWLEDGE_DOCS_ROOT ??
		process.env.KNOWLEDGE_REPO_ROOT ??
		process.cwd();
	const db = openKnowledgeDb();
	try {
		const r = db
			.query(
				"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, domain, area, code_origin, origin_sid, source_ref, source_hash) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				Date.now(),
				job.source,
				job.payload,
				job.domain ?? null,
				job.area ?? null,
				job.codeOrigin ?? null,
				job.originSid ?? null,
				ref || null,
				ref ? fileHash(root, ref) : null,
			);
		return Number(r.lastInsertRowid);
	} finally {
		db.close();
	}
}

// W100: normalize the explanatory suffixes off a declared ref — the trust
// layer (trustOf, coord knowledge-verify) resolves only the leading path, so
// the queue stores that path itself: "hooks/bin/work.ts take (W60)" →
// "hooks/bin/work.ts", "docs/x.md — why it matters" → "docs/x.md".
export function normalizeSourceRef(ref: string): string {
	return (ref.trim().split(/\s+/)[0] ?? "").replace(/[—–].*$/, "");
}

// sha256 of the file a ref names under root — same utf8 bytes trustOf and
// coord knowledge-verify hash. Unresolvable → null (honest unverified).
function fileHash(root: string, ref: string): string | null {
	try {
		return createHash("sha256")
			.update(readFileSync(join(root, ref), "utf8"))
			.digest("hex");
	} catch {
		return null;
	}
}
