// src/ledger.ts — usage ledger: hour-bucket aggregate table, govdb-shaped,
// swap-ready for the W92 openStore binding later (statements live in one
// place; the binding swap changes the constructor, not the SQL shape).
// Key ids are a truncated SHA-256 of the bearer token — token material never
// touches the ledger (SECURITY: nothing hashable → empty string).
import { Database, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	buildSettleFact,
	safeCorrelationId,
	safeRefusalCode,
	type HopReceipt,
	type StreamSettle,
	type StreamCloser,
} from "../../telemetry/src/http-trace.ts";
import type { HopKind } from "./hop.ts";
import type { Usage } from "./usage.ts";

/** W1086 settle receipt: the caller hands raw timings; the ledger validates
 *  + bounds every field before anything durable is written. */
export interface SettleReceipt {
	rid: string;
	traceId: string;
	firstByteAt: number | null;
	lastByteAt: number | null;
	closer: StreamCloser;
	error?: unknown;
	/** Pre-typed failure kind from the close site (RouterError.kind,
	 *  in_band:<type>, stream_truncated) — clamped, never re-derived. */
	failureKind?: string | null;
}

export interface UsageRecord {
	key: string;
	group: string;
	model: string;
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

/** W136 §6 decision row (the outcome fields ride the same table row). */
export interface RouteAuditDecision {
	rid: string;
	/** W3C trace ID from the accepted inbound traceparent (or generated root). */
	trace_id?: string | null;
	ts: string;
	actor: string;
	/** W1 per-lane attribution: the /w/<slug> slug when the request rode a
	 *  lane-prefixed ingress path; '' for bare paths. */
	lane: string;
	dialect: string;
	hint: string;
	candidates_seen: number;
	candidates_top: string;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
	decision: string;
	latency_class: string;
	tier: string;
	allow_cloud: boolean;
	error_code: string | null;
	why: string;
	/** W706 hop marker: 'origin' = the request entered the fleet at this hub
	 *  and this row is the designated billing source; 'forwarded' = a peer
	 *  hub relayed the leg — evidence only, never billed again. Exactly one
	 *  billable row per relayed request. */
	hop: HopKind;
	/** W921 traffic kind: 'readiness' = a marked root-auth healthcheck
	 *  synthetic (excluded from lane cache analytics), 'inference' = agent
	 *  traffic. NULL = the row predates the column. */
	traffic_kind?: string | null;
}

export interface RouteAuditOutcome {
	status: number;
	duration_ms: number;
	ok: boolean;
	err: string | null;
	decision?: string;
	error_code?: string;
	/** W824: ladder-walk attempt count at settle (null = not recorded —
	 *  denial rows, aborted walks). */
	attempts?: number | null;
	/** W1106 body-free stream termination receipt: typed terminal + progress
	 *  counters, never payload. null/absent = the request did not stream. */
	stream_receipt?: StreamReceipt | null;
}

/** W1106: how a streaming body actually ended — typed terminal, upstream
 *  progress counters, last-chunk timestamp (ms from t0). Body-free: no
 *  prompt or completion content ever rides this. */
export interface StreamReceipt {
	/** upstream_eof = clean provider close; upstream_error:<kind> = the
	 *  provider died mid-stream; downstream_cancel = the client hung up;
	 *  upstream_idle/total_deadline = the wire guards fired. */
	terminal: string;
	/** bytes/chunks seen FROM the upstream (activity evidence). */
	bytes_in: number;
	chunks_in: number;
	/** ms from request start to the last upstream chunk (null = none). */
	last_chunk_ms: number | null;
}

/** W457 cache telemetry: provider-reported cache numbers joined onto the
 *  per-request audit row. cache_r = OpenAI usage.prompt_tokens_details.
 *  cached_tokens OR Anthropic usage.cache_read_input_tokens; cache_c =
 *  Anthropic usage.cache_creation_input_tokens (the canonical Usage mapping
 *  from usage.ts — the dialect column says which shape fed it). W824: the
 *  full Usage joins (in/out tokens too) — per-request inspection surfaces
 *  tokens in/out beside the cache columns. */
export type RouteAuditUsage = Usage;

/** W824 GET /v1/admin/requests query — all filters optional, limit is the
 *  row cap (validated + clamped in the caller, re-clamped here). */
export interface RequestReadQuery {
	limit: number;
	/** Inclusive ISO-ts window (lexical compare — audit ts is ISO). */
	since?: string | null;
	until?: string | null;
	/** The presented-credential key id (route_audit.actor). */
	key?: string | null;
	lane?: string | null;
	trace_id?: string | null;
	model?: string | null;
	/** Exclude rejected/unrouted ingress before applying the read cap. */
	inference?: boolean;
	/** true = only rows where the outcome never landed ok. */
	errors?: boolean;
}

/** One per-request inspection row (W824): decision + outcome + usage,
 *  key NAME joined by the caller (never key material). */
export interface RequestReadRow {
	rid: string;
	trace_id: string | null;
	ts: string;
	actor: string;
	lane: string;
	dialect: string;
	hint: string;
	candidates_seen: number;
	candidates_top: string;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
	decision: string;
	latency_class: string;
	tier: string;
	allow_cloud: number;
	hop: string | null;
	error_code: string | null;
	why: string;
	status: number | null;
	duration_ms: number | null;
	ok: number | null;
	err: string | null;
	attempts: number | null;
	cache_r: number | null;
	cache_c: number | null;
	/** 1 = provider explicitly reported cache fields; 0 = usage lacked them. */
	cache_reported: number | null;
	/** 1 = cache creation tokens were explicitly reported; NULL = legacy. */
	cache_c_reported: number | null;
	in_tok: number | null;
	out_tok: number | null;
	/** W921 traffic kind: 'readiness' | 'inference'; NULL = legacy row. */
	traffic_kind: string | null;
	/** W1106 typed stream terminal (null = non-stream row / legacy). */
	stream_receipt: StreamReceipt | null;
	upstream_refusal_code: string | null;
	refusal_origin:
		| "upstream"
		| "bridged-upstream"
		| "network"
		| "local-admission"
		| null;
	retry_after_ms: number | null;
	selected_target_exact: boolean;
	selected_target_attempted: boolean;
}

interface AttemptProvenanceRow {
	rid: string;
	candidate: string;
	upstream_refusal_code: string | null;
	refusal_origin: RequestReadRow["refusal_origin"];
	retry_after_ms: number | null;
}

const INSERT_AUDIT = `
INSERT INTO route_audit (
  rid, trace_id, ts, actor, lane, dialect, hint,
  candidates_seen, candidates_top,
  target_kind, target_host, target_port, target_model,
  decision, latency_class, tier, allow_cloud, error_code, why, hop,
  traffic_kind
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS router_usage (
  hour_bucket TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  model_group TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  cache_r INTEGER NOT NULL DEFAULT 0,
  cache_c INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, key, model_group, model)
);
CREATE TABLE IF NOT EXISTS route_audit (
  rid TEXT PRIMARY KEY,
	trace_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT '',
  dialect TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  candidates_top TEXT NOT NULL DEFAULT '',
  target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT,
  decision TEXT NOT NULL DEFAULT '',
  latency_class TEXT NOT NULL DEFAULT 'unproven',
  tier TEXT NOT NULL DEFAULT '',
  allow_cloud INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  why TEXT NOT NULL DEFAULT '',
  status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT,
  attempts INTEGER,
  cache_r INTEGER, cache_c INTEGER, cache_reported INTEGER,
  cache_c_reported INTEGER,
  in_tok INTEGER, out_tok INTEGER,
  hop TEXT,
  traffic_kind TEXT
);
CREATE TABLE IF NOT EXISTS route_attempt (
  rid TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  service TEXT NOT NULL,
  hop TEXT NOT NULL,
  candidate TEXT NOT NULL,
  status INTEGER,
  refusal TEXT,
  duration_ms INTEGER NOT NULL,
  retry_after_ms INTEGER,
  upstream_id TEXT,
  call_id TEXT,
	upstream_refusal_code TEXT,
	refusal_origin TEXT,
	provider_pool TEXT,
	queue_wait_ms INTEGER,
  PRIMARY KEY (rid, ordinal)
);
CREATE INDEX IF NOT EXISTS route_attempt_trace ON route_attempt(trace_id, ts);
CREATE TABLE IF NOT EXISTS stream_settle (
  rid TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  first_byte_ms INTEGER,
  last_byte_ms INTEGER,
  closer TEXT NOT NULL,
  failure_kind TEXT
);
CREATE INDEX IF NOT EXISTS stream_settle_trace ON stream_settle(trace_id, ts);
`;

const UPSERT = `
INSERT INTO router_usage (
  hour_bucket, key, model_group, model,
  in_tok, out_tok, cache_r, cache_c, requests
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(hour_bucket, key, model_group, model) DO UPDATE SET
  in_tok = in_tok + excluded.in_tok,
  out_tok = out_tok + excluded.out_tok,
  cache_r = cache_r + excluded.cache_r,
  cache_c = cache_c + excluded.cache_c,
  requests = requests + excluded.requests
`;

/** One pending audit operation, applied in order at flush time (the
 *  decision INSERT rides ahead of its outcome UPDATE — order is the join;
 *  the W457 usage UPDATE lands wherever the response settles, keyed by rid). */
type AuditOp =
	| { t: "ins"; row: RouteAuditDecision }
	| { t: "upd"; rid: string; out: RouteAuditOutcome }
	| { t: "attempt"; row: HopReceipt; ts: string }
	| { t: "settle"; rid: string; traceId: string; s: StreamSettle; ts: string }
	| {
			t: "use";
			rid: string;
			u: RouteAuditUsage;
			cacheReported: boolean | null;
			cacheWriteReported: boolean | null;
	  };

const UPDATE_USAGE = `
UPDATE route_audit SET cache_r = ?, cache_c = ?, cache_reported = ?, cache_c_reported = ?,
  in_tok = ?, out_tok = ?
WHERE rid = ?
`;

const UPDATE_AUDIT = `
UPDATE route_audit SET status = ?, duration_ms = ?, ok = ?, err = ?,
  decision = COALESCE(?, decision), error_code = COALESCE(?, error_code),
  attempts = COALESCE(?, attempts),
  stream_receipt = COALESCE(?, stream_receipt)
WHERE rid = ?
`;

export interface LedgerOptions {
	/** async flush cadence (W143 speed §3; default 5s) */
	flushMs?: number;
	/** flush trigger by pending rows (default 256) */
	flushRows?: number;
	/** flush attempts a row survives before it is dropped (default 5) */
	maxFlushAttempts?: number;
	/** W450 pending-entry cap per ring: flush latency must not grow with
	 *  unbounded queue depth. Overflow sheds the OLDEST row (counted). */
	maxPendingEntries?: number;
	/** W450 pending-byte cap per ring: one huge err/why string (readCapped
	 *  error bodies reach 256 KiB) cannot balloon the ring. */
	maxPendingBytes?: number;
	/** drop observer — the servicemon counter seam (buckle_ledger_dropped_total) */
	onDrop?: (kind: "usage" | "audit", n: number) => void;
}

/** A ring entry with its failed-flush count (bounded retry) and its byte
 *  estimate (W450 ring bounds — tracked at push, O(1) to shed). */
type Pending<T> = { v: T; tries: number; b: number };

export class Ledger {
	private readonly db: Database;
	private readonly upsert: ReturnType<Database["query"]>;
	// W450: audit statements prepared once (measured ~5%/op over the cached
	// db.query() lookup at 2k-op flushes; the flush is background, but the
	// hoist is free and keeps every hot statement beside upsert).
	private readonly insAudit: ReturnType<Database["query"]>;
	private readonly updAudit: ReturnType<Database["query"]>;
	private readonly updUsage: ReturnType<Database["query"]>;
	private readonly insAttempt: ReturnType<Database["query"]>;
	/** W1086 settle statement — beside insAttempt (same flush path). */
	private readonly insSettle: Statement;
	private readonly flushMs: number;
	private readonly flushRows: number;
	private readonly maxAttempts: number;
	private readonly maxPending: number;
	private readonly maxPendingBytes: number;
	private readonly onDrop?: (kind: "usage" | "audit", n: number) => void;
	private usageRing: Array<Pending<UsageRecord & { bucket: string }>> = [];
	private auditRing: Array<Pending<AuditOp>> = [];
	/** W450 ring byte loads (sum of the entries' `b`). */
	private usageBytes = 0;
	private auditBytes = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushQueued = false;
	/** flush transactions that threw — the fire-and-forget counter. */
	flushFails = 0;
	/** rows dropped after maxFlushAttempts failed flushes (usage + audit). */
	dropped = 0;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
		opts: LedgerOptions = {},
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		// W1: pre-lane databases keep their table (CREATE IF NOT EXISTS won't
		// add the column) — ALTER it in; a duplicate column just means the
		// schema is already current.
		try {
			this.db.exec(
				"ALTER TABLE route_audit ADD COLUMN lane TEXT NOT NULL DEFAULT ''",
			);
		} catch {
			// column exists — schema current
		}
		// W457: cache telemetry columns (pre-cache databases heal; one ALTER
		// per missing column, checked via pragma — idempotent on every open).
		const auditCols = (
			this.db
				.query("SELECT name FROM pragma_table_info('route_audit')")
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		if (!auditCols.includes("cache_r"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN cache_r INTEGER");
		if (!auditCols.includes("cache_c"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN cache_c INTEGER");
		if (!auditCols.includes("cache_reported"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN cache_reported INTEGER");
		if (!auditCols.includes("cache_c_reported"))
			this.db.run(
				"ALTER TABLE route_audit ADD COLUMN cache_c_reported INTEGER",
			);
		// W706: hop marker (pre-W706 databases heal the same way; NULL hop =
		// unmarked legacy row — billable, the pre-W706 default).
		if (!auditCols.includes("hop"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN hop TEXT");
		// W824: attempts + per-request token columns heal onto pre-W824 dbs
		// the same way — idempotent per open (pragma-checked), NULL = the
		// row predates the column (honest unknown, never zero-faked).
		if (!auditCols.includes("attempts"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN attempts INTEGER");
		if (!auditCols.includes("in_tok"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN in_tok INTEGER");
		if (!auditCols.includes("out_tok"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN out_tok INTEGER");
		if (!auditCols.includes("trace_id"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN trace_id TEXT");
		// W921: traffic kind (pre-W921 databases heal the same way; NULL =
		// the row predates the column — unmarked legacy).
		if (!auditCols.includes("traffic_kind"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN traffic_kind TEXT");
		// W1106: body-free stream termination receipt — JSON {bytes_in,
		// chunks_in, last_chunk_ms, terminal}; NULL = the row predates the
		// column or the request never streamed.
		if (!auditCols.includes("stream_receipt"))
			this.db.run("ALTER TABLE route_audit ADD COLUMN stream_receipt TEXT");
		this.db.run(
			"CREATE INDEX IF NOT EXISTS route_audit_trace ON route_audit(trace_id, ts)",
		);
		const attemptCols = this.db
			.query("SELECT name FROM pragma_table_info('route_attempt')")
			.all()
			.map((row) => (row as { name: string }).name);
		if (!attemptCols.includes("upstream_refusal_code"))
			this.db.run(
				"ALTER TABLE route_attempt ADD COLUMN upstream_refusal_code TEXT",
			);
		if (!attemptCols.includes("refusal_origin"))
			this.db.run("ALTER TABLE route_attempt ADD COLUMN refusal_origin TEXT");
		if (!attemptCols.includes("provider_pool"))
			this.db.run("ALTER TABLE route_attempt ADD COLUMN provider_pool TEXT");
		if (!attemptCols.includes("queue_wait_ms"))
			this.db.run("ALTER TABLE route_attempt ADD COLUMN queue_wait_ms INTEGER");
		this.upsert = this.db.query(UPSERT);
		this.insAudit = this.db.query(INSERT_AUDIT);
		this.updAudit = this.db.query(UPDATE_AUDIT);
		this.updUsage = this.db.query(UPDATE_USAGE);
		this.insAttempt = this.db.query(`INSERT OR REPLACE INTO route_attempt
			(rid, ordinal, trace_id, ts, service, hop, candidate, status,
			refusal, duration_ms, retry_after_ms, upstream_id, call_id,
			upstream_refusal_code, refusal_origin, provider_pool, queue_wait_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		this.insSettle = this.db.query(`INSERT OR REPLACE INTO stream_settle
			(rid, trace_id, ts, first_byte_ms, last_byte_ms, closer, failure_kind)
			VALUES (?, ?, ?, ?, ?, ?, ?)`);
		this.flushMs = opts.flushMs ?? 5000;
		this.flushRows = opts.flushRows ?? 256;
		this.maxAttempts = Math.max(1, opts.maxFlushAttempts ?? 5);
		this.maxPending = Math.max(1, opts.maxPendingEntries ?? 4096);
		this.maxPendingBytes = Math.max(1, opts.maxPendingBytes ?? 4 * 1024 * 1024);
		this.onDrop = opts.onDrop;
		this.timer = setInterval(() => this.flush(), this.flushMs);
		// never holds the process open (bun test, the bench harness)
		this.timer.unref?.();
	}

	/** W450 ring-byte estimates: fixed-shape numbers cost a constant base,
	 *  strings count as UTF-16 length (an honest over-count of UTF-8). The
	 *  upd estimate skips decision/error_code — router-bounded small; err is
	 *  the only unbounded string (readCapped error bodies reach 256 KiB). */
	private usageRecBytes(r: UsageRecord & { bucket: string }): number {
		return 96 + r.key.length + r.group.length + r.model.length;
	}
	private auditOpBytes(op: AuditOp): number {
		if (op.t === "ins") {
			const r = op.row;
			return (
				96 +
				r.rid.length +
				r.ts.length +
				r.actor.length +
				r.lane.length +
				r.dialect.length +
				r.hint.length +
				r.candidates_top.length +
				r.decision.length +
				r.latency_class.length +
				r.tier.length +
				r.why.length
			);
		}
		if (op.t === "upd")
			return (
				64 +
				op.rid.length +
				(op.out.err?.length ?? 0) +
				(op.out.stream_receipt
					? JSON.stringify(op.out.stream_receipt).length
					: 0)
			);
		if (op.t === "attempt") {
			const r = op.row;
			return (
				96 +
				r.rid.length +
				r.traceId.length +
				r.service.length +
				r.hop.length +
				r.candidate.length +
				(r.refusal?.length ?? 0) +
				(r.upstreamId?.length ?? 0) +
				(r.callId?.length ?? 0)
			);
		}
		if (op.t === "settle")
			return (
				64 +
				op.rid.length +
				op.traceId.length +
				op.ts.length +
				op.s.closer.length +
				(op.s.failureKind?.length ?? 0)
			);
		return 32 + op.rid.length;
	}

	/** Enqueue a usage row / audit op, then enforce the ring caps. */
	private pushUsage(v: UsageRecord & { bucket: string }): void {
		const b = this.usageRecBytes(v);
		this.usageBytes += b;
		this.usageRing.push({ v, tries: 0, b });
		this.bound(this.usageRing, "usage");
	}

	private pushAudit(op: AuditOp): void {
		const b = this.auditOpBytes(op);
		this.auditBytes += b;
		this.auditRing.push({ v: op, tries: 0, b });
		this.bound(this.auditRing, "audit");
	}

	/** W450 ring bound: shed the OLDEST entries until the ring fits its
	 *  entry/byte caps — freshest observations win, every drop is counted. */
	private bound<T>(ring: Array<Pending<T>>, kind: "usage" | "audit"): void {
		let evicted = 0;
		const bytes = () => (kind === "usage" ? this.usageBytes : this.auditBytes);
		while (
			ring.length > this.maxPending ||
			(ring.length > 0 && bytes() > this.maxPendingBytes)
		) {
			const old = ring.shift();
			if (old === undefined) break;
			if (kind === "usage") this.usageBytes -= old.b;
			else this.auditBytes -= old.b;
			evicted++;
		}
		if (evicted > 0) {
			this.dropped += evicted;
			this.onDrop?.(kind, evicted);
		}
	}

	/** Upsert-add into the hour bucket for now(): enqueued (bounded by the
	 *  5s timer / the row threshold — never on the request's stack). */
	record(rec: UsageRecord): void {
		const bucket = `${this.now().toISOString().slice(0, 13)}:00`;
		this.pushUsage({ ...rec, bucket });
		if (this.usageRing.length >= this.flushRows) this.flushSoon();
	}

	/** Defer one flush off the caller's stack (the threshold trigger). */
	private flushSoon(): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		const t = setTimeout(() => {
			this.flushQueued = false;
			this.flush();
		}, 0);
		t.unref?.();
	}

	/** One transaction for everything pending (W143 speed §3): usage upserts
	 *  then audit ops in arrival order. Failure never throws (the W140
	 *  fire-and-forget contract) but never loses rows silently either: the
	 *  transaction rolled back, so the batch is requeued ahead of newer rows
	 *  and retried; a row is dropped (counted in `dropped` + onDrop) only
	 *  after maxFlushAttempts failed flushes. */
	flush(): void {
		const usage = this.usageRing;
		const audit = this.auditRing;
		if (usage.length === 0 && audit.length === 0) return;
		this.usageRing = [];
		this.auditRing = [];
		this.usageBytes = 0;
		this.auditBytes = 0;
		try {
			this.db.transaction(() => {
				for (const { v: r } of usage)
					this.upsert.run(
						r.bucket,
						r.key,
						r.group,
						r.model,
						r.in_tok,
						r.out_tok,
						r.cache_r,
						r.cache_c,
						r.requests,
					);
				for (const { v: op } of audit) {
					if (op.t === "ins") this.insertAudit(op.row);
					else if (op.t === "upd") this.updateAudit(op.rid, op.out);
					else if (op.t === "attempt") this.insertAttempt(op.row, op.ts);
					else if (op.t === "settle") this.insertSettle(op);
					else
						this.updateUsageRow(
							op.rid,
							op.u,
							op.cacheReported,
							op.cacheWriteReported,
						);
				}
			})();
		} catch {
			this.flushFails++;
			const ku = this.requeue("usage", usage);
			const ka = this.requeue("audit", audit);
			this.usageBytes = ku.reduce((s, p) => s + p.b, 0);
			this.auditBytes = ka.reduce((s, p) => s + p.b, 0);
			this.usageRing = [...ku, ...this.usageRing];
			this.auditRing = [...ka, ...this.auditRing];
		}
	}

	/** Failed batch → survivors (tries+1 < max) for the ring head; the rest
	 *  are dropped and counted. */
	private requeue<T>(
		kind: "usage" | "audit",
		batch: Array<Pending<T>>,
	): Array<Pending<T>> {
		const keep: Array<Pending<T>> = [];
		let lost = 0;
		for (const p of batch) {
			if (p.tries + 1 >= this.maxAttempts) lost++;
			else keep.push({ v: p.v, tries: p.tries + 1, b: p.b });
		}
		if (lost > 0) {
			this.dropped += lost;
			this.onDrop?.(kind, lost);
		}
		return keep;
	}

	/** Rows waiting for the next flush (usage + audit ops). */
	pending(): number {
		return this.usageRing.length + this.auditRing.length;
	}

	/** W450: bytes held by the pending rings (usage + audit estimates). */
	pendingBytes(): number {
		return this.usageBytes + this.auditBytes;
	}

	/** Read-back for tests / status inspection. Read barrier: pending rows
	 *  flush first, so readers never see stale ring state. */
	rows(): Array<Record<string, unknown>> {
		this.flush();
		const stmt = this.db.query("SELECT * FROM router_usage");
		return stmt.all() as Array<Record<string, unknown>>;
	}

	// ─── route_audit (W136 §6): one decision row per request, joined by rid
	// to the outcome written after completion. Fire-and-forget WAL inserts —
	// a failed audit write never fails the route (belt precedent). ───

	/** Insert the decision row (target already known at dispatch): enqueued;
	 *  the flush applies INSERTs and UPDATEs in arrival order. */
	auditDecision(row: RouteAuditDecision): void {
		this.pushAudit({ t: "ins", row });
		if (this.auditRing.length >= this.flushRows) this.flushSoon();
	}

	/** Bounded, body-free attempt receipts share the audit ring and its
	 * backpressure. A missing/unsafe correlation ID is never persisted. */
	auditAttempt(row: HopReceipt): void {
		if (!/^[0-9a-f]{32}$/.test(row.traceId)) return;
		if (
			!safeCorrelationId(row.rid) ||
			!Number.isSafeInteger(row.ordinal) ||
			row.ordinal < 1
		)
			return;
		this.pushAudit({ t: "attempt", row, ts: this.now().toISOString() });
		if (this.auditRing.length >= this.flushRows) this.flushSoon();
	}

	/** W1086 stream settle: the caller observes the close and hands raw
	 *  timings; every field is validated + bounded HERE (closer enum, ms
	 *  clamp, failure kind reduced via buildSettleFact). One row per rid —
	 *  the final settle stands, retries REPLACE. */
	auditSettle(receipt: SettleReceipt, t0: number): void {
		if (!/^[0-9a-f]{32}$/.test(receipt.traceId)) return;
		if (!safeCorrelationId(receipt.rid)) return;
		const s = buildSettleFact({
			t0,
			firstByteAt: receipt.firstByteAt,
			lastByteAt: receipt.lastByteAt,
			closer: receipt.closer,
			error: receipt.error,
			failureKind: receipt.failureKind,
		});
		this.pushAudit({
			t: "settle",
			rid: receipt.rid,
			traceId: receipt.traceId,
			s,
			ts: this.now().toISOString(),
		});
		if (this.auditRing.length >= this.flushRows) this.flushSoon();
	}

	private insertAttempt(row: HopReceipt, ts: string): void {
		this.insAttempt.run(
			row.rid,
			row.ordinal,
			row.traceId,
			ts,
			safeCorrelationId(row.service) ?? "unknown",
			safeCorrelationId(row.hop) ?? "unknown",
			safeCorrelationId(row.candidate) ?? "unknown",
			row.status !== null &&
				Number.isSafeInteger(row.status) &&
				row.status >= 100 &&
				row.status <= 599
				? row.status
				: null,
			safeCorrelationId(row.refusal) ?? null,
			Number.isFinite(row.durationMs)
				? Math.max(0, Math.floor(row.durationMs))
				: 0,
			row.retryAfterMs !== null && Number.isFinite(row.retryAfterMs)
				? Math.max(0, Math.floor(row.retryAfterMs))
				: null,
			safeCorrelationId(row.upstreamId) ?? null,
			safeCorrelationId(row.callId) ?? null,
			safeRefusalCode(row.upstreamRefusalCode),
			row.refusalOrigin === "upstream" ||
				row.refusalOrigin === "bridged-upstream" ||
				row.refusalOrigin === "network"
				? row.refusalOrigin
				: null,
			safeCorrelationId(row.providerPool) ?? null,
			Number.isSafeInteger(row.queueWaitMs) && (row.queueWaitMs ?? -1) >= 0
				? row.queueWaitMs
				: null,
		);
	}

	/** W1086: one settle row per rid — the final settle stands, retries
	 *  REPLACE. Fields arrive pre-bounded via buildSettleFact. */
	private insertSettle(op: {
		rid: string;
		traceId: string;
		s: StreamSettle;
		ts: string;
	}): void {
		this.insSettle.run(
			safeCorrelationId(op.rid) ?? "unknown",
			safeCorrelationId(op.traceId) ?? "unknown",
			op.ts,
			op.s.firstByteMs,
			op.s.lastByteMs,
			op.s.closer,
			op.s.failureKind,
		);
	}

	/** One trace's observed attempts, in walk order. Legacy requests simply
	 * return an empty list. The read barrier includes queued receipts. */
	traceAttempts(traceId: string): Array<Record<string, unknown>> {
		if (!/^[0-9a-f]{32}$/.test(traceId)) return [];
		this.flush();
		return this.db
			.query(`SELECT rid, ordinal, trace_id, ts, service, hop,
			candidate, status, refusal, duration_ms, retry_after_ms, upstream_id,
			call_id, upstream_refusal_code, refusal_origin, provider_pool, queue_wait_ms FROM route_attempt WHERE trace_id = ?
			ORDER BY ts, rid, ordinal LIMIT 500`)
			.all(traceId) as Array<Record<string, unknown>>;
	}

	/** The flush-time INSERT (extracted from the old inline body). */
	private insertAudit(row: RouteAuditDecision): void {
		this.insAudit.run(
			row.rid,
			row.trace_id ?? null,
			row.ts,
			row.actor,
			row.lane,
			row.dialect,
			row.hint,
			row.candidates_seen,
			row.candidates_top,
			row.target_kind,
			row.target_host,
			row.target_port,
			row.target_model,
			row.decision,
			row.latency_class,
			row.tier,
			row.allow_cloud ? 1 : 0,
			row.error_code,
			row.why,
			row.hop,
			row.traffic_kind ?? null,
		);
	}

	/** Update the decision row with the outcome (joined by rid): enqueued. */
	auditOutcome(rid: string, out: RouteAuditOutcome): void {
		this.pushAudit({ t: "upd", rid, out });
	}

	/** The flush-time UPDATE (extracted from the old inline body). W824:
	 *  attempts rides COALESCE — a NULL-attempts row (denial) updated by a
	 *  later real outcome keeps its attempt count, never a masking overwrite. */
	private updateAudit(rid: string, out: RouteAuditOutcome): void {
		this.updAudit.run(
			out.status,
			out.duration_ms,
			out.ok ? 1 : 0,
			out.err,
			out.decision ?? null,
			out.error_code ?? null,
			out.attempts ?? null,
			out.stream_receipt === undefined
				? null
				: out.stream_receipt === null
					? null
					: JSON.stringify(out.stream_receipt),
			rid,
		);
	}

	/** W457: provider-reported cache usage onto the per-request audit row
	 *  (joined by rid): enqueued. A null Usage is honest unknown — the
	 *  UPDATE is skipped so the columns stay NULL, never estimated. W824:
	 *  the full Usage joins (tokens in/out ride the same op). */
	auditUsage(
		rid: string,
		u: Usage | null,
		cacheReported: boolean | null = null,
		cacheWriteReported: boolean | null = null,
	): void {
		if (u === null) return;
		this.pushAudit({
			t: "use",
			rid,
			u: { ...u },
			cacheReported,
			cacheWriteReported,
		});
	}

	/** The flush-time cache UPDATE (W457). */
	private updateUsageRow(
		rid: string,
		u: RouteAuditUsage,
		cacheReported: boolean | null,
		cacheWriteReported: boolean | null,
	): void {
		this.updUsage.run(
			u.cache_r,
			cacheWriteReported ? u.cache_c : null,
			cacheReported === null ? null : cacheReported ? 1 : 0,
			cacheWriteReported === null ? null : cacheWriteReported ? 1 : 0,
			u.in_tok,
			u.out_tok,
			rid,
		);
	}

	/** Read-back for tests / dashboards. Read barrier: pending audit ops
	 *  flush first (INSERTs ahead of their UPDATEs — order preserved). */
	auditRows(): Array<Record<string, unknown>> {
		this.flush();
		return this.db
			.query("SELECT * FROM route_audit ORDER BY ts")
			.all() as Array<Record<string, unknown>>;
	}

	/** W824: the capped per-request read behind GET /v1/admin/requests.
	 *  Read barrier: pending ops flush first. Newest-first; err/why are
	 *  truncated at read (error bodies reach the W450 256 KiB cap — this
	 *  surface never re-serves request/response bodies). */
	requestsRead(q: RequestReadQuery): RequestReadRow[] {
		this.flush();
		const limit = Math.min(Math.max(Math.floor(q.limit), 1), 500);
		const where: string[] = [];
		const args: Array<string | number> = [];
		if (q.key) {
			where.push("actor = ?");
			args.push(q.key);
		}
		if (q.lane) {
			where.push("lane = ?");
			args.push(q.lane);
		}
		if (q.trace_id) {
			where.push("trace_id = ?");
			args.push(q.trace_id);
		}
		if (q.model) {
			where.push("target_model = ?");
			args.push(q.model);
		}
		if (q.inference === true) where.push("target_model IS NOT NULL");
		if (q.errors === true) {
			where.push("ok = 0");
		}
		if (q.since) {
			where.push("ts >= ?");
			args.push(q.since);
		}
		if (q.until) {
			where.push("ts < ?");
			args.push(q.until);
		}
		const rows = this.db
			.query(requestsReadSql(where, limit))
			.all(...args) as RequestReadRow[];
		const receipts = rows.length
			? (this.db
					.query(`SELECT rid, candidate, upstream_refusal_code, refusal_origin,
						retry_after_ms FROM route_attempt WHERE rid IN
						(${rows.map(() => "?").join(",")}) ORDER BY rid, ordinal`)
					.all(...rows.map((row) => row.rid)) as AttemptProvenanceRow[])
			: [];
		const byRid = new Map<string, AttemptProvenanceRow[]>();
		for (const receipt of receipts) {
			const attempts = byRid.get(receipt.rid) ?? [];
			attempts.push(receipt);
			byRid.set(receipt.rid, attempts);
		}
		return rows.map((r) => {
			const attempts = byRid.get(r.rid) ?? [];
			const selected = r.candidates_top.split(",")[0] ?? "";
			const selectedHash = selected
				? createHash("sha256").update(selected).digest("hex").slice(0, 16)
				: null;
			const selectedTargetExact =
				r.candidates_seen === 1 &&
				r.ok !== null &&
				r.attempts !== null &&
				r.attempts === attempts.length &&
				r.target_kind !== null &&
				r.target_host !== null &&
				r.target_port !== null &&
				selectedHash !== null &&
				attempts.every((receipt) => receipt.candidate === selectedHash);
			const failed = attempts.filter(
				(receipt) => receipt.refusal_origin !== null,
			);
			const refusal =
				failed.findLast((receipt) => receipt.upstream_refusal_code !== null) ??
				failed.at(-1);
			const failedResponse = r.status !== null && r.status >= 400;
			return {
				...r,
				err: capRequestText(r.err),
				why: capRequestText(r.why) ?? "",
				stream_receipt: parseStreamReceipt(r.stream_receipt),
				upstream_refusal_code: failedResponse
					? (refusal?.upstream_refusal_code ?? null)
					: null,
				refusal_origin: failedResponse
					? (refusal?.refusal_origin ?? null)
					: null,
				retry_after_ms: failedResponse
					? (refusal?.retry_after_ms ?? null)
					: null,
				selected_target_exact: selectedTargetExact,
				selected_target_attempted: selectedTargetExact && attempts.length > 0,
			};
		});
	}

	/** W1086 trace-centric read: the per-request audit rows + hop attempts +
	 *  the stream settle row for ONE trace — the LiteLLM call id joins by
	 *  trace_id (route_attempt.call_id), never by probing. Bounded,
	 *  body-free. */
	traceRead(traceId: string): {
		trace_id: string;
		requests: RequestReadRow[];
		attempts: Array<Record<string, unknown>>;
		settle: Record<string, unknown> | null;
	} {
		if (!/^[0-9a-f]{32}$/.test(traceId))
			return { trace_id: traceId, requests: [], attempts: [], settle: null };
		this.flush();
		const settle = (
			this.db
				.query(`SELECT rid, trace_id, ts, first_byte_ms, last_byte_ms,
			closer, failure_kind FROM stream_settle WHERE trace_id = ?
			ORDER BY ts DESC LIMIT 1`)
				.all(traceId) as Array<Record<string, unknown>>
		)[0];
		return {
			trace_id: traceId,
			requests: this.requestsRead({ limit: 200, trace_id: traceId }),
			attempts: this.traceAttempts(traceId),
			settle: settle ?? null,
		};
	}

	close(): void {
		// drain: each failed flush ages the batch, so this ends within
		// maxAttempts passes — survivors land, the rest are counted drops
		for (let i = 0; i < this.maxAttempts && this.pending() > 0; i++)
			this.flush();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.db.close();
	}
}

/** W824: the requestsRead SELECT — one shared column list (the inspection
 *  read never widens beyond these fields), caller-built WHERE joined, the
 *  clamped integer limit inlined (never injectable). */
const REQUEST_WHY_CAP = 200;

/** W824 read cap on free-text columns (err/why): upstream error bodies can
 *  reach the W450 256 KiB ring cap — the inspection surface never re-serves
 *  request/response bodies, so long text truncates at read (marked). */
function capRequestText(s: string | null): string | null {
	if (s === null) return null;
	return s.length <= REQUEST_WHY_CAP ? s : `${s.slice(0, REQUEST_WHY_CAP)}…`;
}
function requestsReadSql(where: string[], limit: number): string {
	const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	return `SELECT rid, trace_id, ts, actor, lane, dialect, hint,
		candidates_seen, candidates_top, target_kind, target_host,
		target_port, target_model, decision, latency_class, tier,
		allow_cloud, hop, error_code, why, status, duration_ms, ok, err,
		attempts, cache_r, cache_c, cache_reported, cache_c_reported, in_tok, out_tok,
		traffic_kind, stream_receipt
		FROM route_audit ${clause}
		ORDER BY ts DESC, rid DESC LIMIT ${limit}`;
}

/** W1106: the stored receipt JSON → typed value (null = absent/legacy/
 *  corrupt — a bad row never kills the read surface). */
function parseStreamReceipt(raw: unknown): StreamReceipt | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	try {
		const j: unknown = JSON.parse(raw);
		if (!j || typeof j !== "object") return null;
		const r = j as Record<string, unknown>;
		if (typeof r.terminal !== "string") return null;
		return {
			terminal: r.terminal,
			bytes_in: typeof r.bytes_in === "number" ? r.bytes_in : 0,
			chunks_in: typeof r.chunks_in === "number" ? r.chunks_in : 0,
			last_chunk_ms:
				typeof r.last_chunk_ms === "number" ? r.last_chunk_ms : null,
		};
	} catch {
		return null;
	}
}

/** Presented credential → truncated sha-256 hex id (12 chars). */
export function keyIdFromToken(token: string | null): string {
	if (!token) return "";
	return new Bun.CryptoHasher("sha256")
		.update(token)
		.digest("hex")
		.slice(0, 12);
}

/** Credential presented by a request: Authorization Bearer first, then the
 *  Anthropic-wire x-api-key (copilot's anthropic dialect rides the official
 *  SDK, which authenticates via x-api-key — W422.17.2). null when neither
 *  header is present; present-but-empty yields "". */
export function tokenFromHeaders(headers: Headers): string | null {
	const m = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
	if (m) return m[1]?.trim() ?? "";
	const apiKey = headers.get("x-api-key");
	return apiKey === null ? null : apiKey.trim();
}
