// src/http-kit.ts — W1303.2 the ONE HTTP contract kit for fleet services:
// the standard-server section (URLPattern route table with correct 404 vs
// 405+Allow and automatic HEAD/OPTIONS, the semantic status matrix, ONE
// error-kinds module emitting problem+json, Idempotency-Key replay with
// body-hash binding, Retry-After CLAMPED on every emission, ETag/If-Match
// conditionals, 202 + status resource, per-caller token buckets + bounded
// shed queue with reserved health capacity, x-request-deadline
// propagation). Adopted incrementally per route family: the buckle aids
// family and the board prompt-settings family are the first two proving
// surfaces. Cross-package adoption rides the @klh/buckle package name.
//
// The error body is the citizenship grammar (RFC 9457 problem+json + the
// fleet extensions code / why / agent_next_steps) so kinds flow service →
// HTTP → UI unchanged; the kit emits for any service via `service:` (buckle
// is the default) and adds the statuses citizenship's gate table lacks
// (412/428/504).
import { createHash } from "node:crypto";
import { z } from "zod";
import { PROBLEM_SLUGS } from "./citizenship.ts";

// ── (2) semantic status matrix ──────────────────────────────────────────────

/** The semantic error kinds. The load-bearing distinctions: rate_limited
 *  (429 — the CALLER sent too much) vs overloaded (503 — WE struggle);
 *  precondition_failed (412 — If-Match mismatch) vs precondition_required
 *  (428 — a write arrived without the required If-Match); validation (422 —
 *  the body parsed but is wrong, field errors attached). */
export type ProblemKind =
	| "bad_request"
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "method_not_allowed"
	| "conflict"
	| "precondition_failed"
	| "precondition_required"
	| "validation"
	| "rate_limited"
	| "upstream"
	| "deadline"
	| "overloaded"
	| "internal";

/** kind → status. The matrix wired to responses via toProblemResponse. */
export const STATUS_OF: Record<ProblemKind, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	method_not_allowed: 405,
	conflict: 409,
	precondition_failed: 412,
	precondition_required: 428,
	validation: 422,
	rate_limited: 429,
	upstream: 502,
	deadline: 504,
	overloaded: 503,
	internal: 500,
};

/** Statuses whose slugs citizenship's gate table lacks — the kit's additive
 *  extension (kept here so the gate table never churns). */
const KIT_SLUG_EXT: Record<number, string> = {
	412: "precondition",
	428: "precondition_required",
	504: "deadline",
	499: "client_closed",
};

const slugOf = (status: number): string =>
	PROBLEM_SLUGS[status] ?? KIT_SLUG_EXT[status] ?? "problem";

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	412: "Precondition Failed",
	422: "Unprocessable Content",
	428: "Precondition Required",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

// ── (3) ONE error-kinds module — HttpProblem → problem+json ────────────────

/** Per-field validation error (the 422 payload). W2173.7 zod-first: the
 *  schema is THE definition; the type is derived, never hand-written. */
export const FieldErrorSchema = z.object({
	field: z.string().min(1),
	why: z.string().min(1),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProblemInitSchema = z.object({
	/** Stable machine code — `service.slug` by convention (buckle.*,
	 *  board.*). Never renamed, only added to. */
	code: z.string().min(1),
	why: z.string().min(1),
	instance: z.string().optional(),
	fields: z.array(FieldErrorSchema).optional(),
	/** Seconds; CLAMPED to the configured max at emission time. */
	retryAfterS: z.number().optional(),
	next: z.array(z.string()).optional(),
	/** Extra wire headers (allow, www-authenticate, ...). */
	headers: z.record(z.string(), z.string()).optional(),
});
export type ProblemInit = z.infer<typeof ProblemInitSchema>;

/** The ONE error kind a service throws/returns. Carries kind + stable code +
 *  the problem fields; toProblemResponse renders it. Never leak internals —
 *  `why` is a curated string by contract. */
export class HttpProblem extends Error {
	readonly kind: ProblemKind;
	readonly status: number;
	readonly code: string;
	readonly instance: string | null;
	readonly fields: FieldError[] | null;
	readonly retryAfterS: number | null;
	readonly next: string[] | null;
	readonly headers: Record<string, string> | null;

	constructor(kind: ProblemKind, init: ProblemInit) {
		super(init.why);
		this.name = "HttpProblem";
		this.kind = kind;
		this.status = STATUS_OF[kind];
		this.code = init.code;
		this.instance = init.instance ?? null;
		this.fields = init.fields ?? null;
		this.retryAfterS = init.retryAfterS ?? null;
		this.next = init.next ?? null;
		this.headers = init.headers ?? null;
	}
}

/** Build the kit problem for a kind. */
export function problemOf(kind: ProblemKind, init: ProblemInit): HttpProblem {
	return new HttpProblem(kind, init);
}

/** HttpProblem → problem+json Response. The Retry-After emission is CLAMPED
 *  here (and everywhere via clampRetryAfter) — a quota wall must never sleep
 *  a client for weeks. Codes carry the service prefix already (p.code). */
export function toProblemResponse(p: HttpProblem): Response {
	const body: Record<string, unknown> = {
		type: `/problems/${slugOf(p.status)}`,
		title: TITLES[p.status] ?? "Problem",
		status: p.status,
		detail: p.message,
		code: p.code,
		why: p.message,
	};
	if (p.instance !== null) body.instance = p.instance;
	if (p.fields !== null) body.errors = p.fields;
	if (p.next !== null) body.agent_next_steps = p.next;
	const h = new Headers({ "content-type": "application/problem+json" });
	if (p.retryAfterS !== null)
		h.set("retry-after", String(clampRetryAfter(p.retryAfterS)));
	for (const [k, v] of Object.entries(p.headers ?? {})) h.set(k, v);
	return new Response(JSON.stringify(body), { status: p.status, headers: h });
}

/** The catch-all: HttpProblem renders itself; anything else renders a 500
 *  problem WITHOUT the internal message (curated strings only). */
export function problemFrom(
	e: unknown,
	opts?: { service?: string; why?: string },
): Response {
	if (e instanceof HttpProblem) return toProblemResponse(e);
	const service = opts?.service ?? "buckle";
	return toProblemResponse(
		problemOf("internal", {
			code: `${service}.internal_error`,
			why: opts?.why ?? "internal error",
		}),
	);
}

// ── (5) Retry-After clamp ───────────────────────────────────────────────────

/** The configured emission max: BUCKLE_RETRY_AFTER_MAX_S (whole fleet reads
 *  the same env name; board included via the kit), default 300s. */
export function retryAfterMaxS(): number {
	const n = Number(process.env.BUCKLE_RETRY_AFTER_MAX_S);
	return Number.isFinite(n) && n > 0 ? n : 300;
}

/** Clamp a retry-after to the configured max — fixes the known bug where a
 *  provider quota wall (days/weeks of retry-after) relayed verbatim and
 *  slept clients for weeks. Non-finite/absent → 0 is never emitted (callers
 *  pass null through instead). */
export function clampRetryAfter(s: number, maxS?: number): number {
	const cap = maxS ?? retryAfterMaxS();
	if (!Number.isFinite(s)) return cap;
	return Math.max(0, Math.min(Math.ceil(s), Math.ceil(cap)));
}

/** Header record for a retry-after that may be absent: {} when null, the
 *  CLAMPED delta-seconds otherwise. */
export function retryAfterHeaders(
	s: number | null | undefined,
	maxS?: number,
): Record<string, string> {
	if (s === null || s === undefined) return {};
	return { "retry-after": String(clampRetryAfter(s, maxS)) };
}

// ── (6) ETag + If-Match ─────────────────────────────────────────────────────

/** Stable stringify (sorted keys) so equal states hash equal. */
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const entries = Object.entries(v as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	);
	return `{${entries
		.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`)
		.join(",")}}`;
}

/** Strong ETag (quoted) over the resource state — 16 hex of sha256. */
export function etagOf(payload: unknown): string {
	const hash = createHash("sha256")
		.update(stableStringify(payload))
		.digest("hex")
		.slice(0, 16);
	return `"${hash}"`;
}

/** If-Match state against the current etag: absent/* → ok (the conditional
 *  is simply not claimed); any other value that differs → mismatch (412). */
export function ifMatchState(h: Headers, etag: string): "ok" | "mismatch" {
	const raw = h.get("if-match");
	if (raw === null) return "ok";
	const token = raw.trim();
	if (token === "*") return "ok";
	return token === etag ? "ok" : "mismatch";
}

/** True when a WRITE arrived without the required If-Match (→ 428). */
export function ifMatchMissing(h: Headers): boolean {
	const raw = h.get("if-match");
	return raw === null || raw.trim() === "";
}

// ── (7) long work → 202 + status resource ──────────────────────────────────

/** Accepted: 202 + Location pointing at the status resource; the body
 *  carries `status` (the path) so agents read it without header access. */
export function accepted202(
	statusPath: string,
	payload: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ ok: true, status: statusPath, ...payload },
		{ status: 202, headers: { location: statusPath } },
	);
}

// ── (9) x-request-deadline propagation ─────────────────────────────────────

export const DEADLINE_HEADER = "x-request-deadline";

/** Absolute epoch-ms by which the caller needs the response. Absent/invalid
 *  → null (no deadline claimed). Expired deadlines parse with
 *  remainingMs <= 0 — the caller decides the problem (504 deadline). */
export function parseRequestDeadline(
	h: Headers,
	now: () => number = Date.now,
): { deadlineMs: number; remainingMs: number } | null {
	const raw = h.get(DEADLINE_HEADER);
	if (raw === null) return null;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return { deadlineMs: ms, remainingMs: ms - now() };
}

/** The forward headers for a downstream hop (same header name — one grammar
 *  end to end). */
export function deadlineHeaders(deadlineMs: number): Record<string, string> {
	return { [DEADLINE_HEADER]: String(deadlineMs) };
}

// ── (4) Idempotency-Key ─────────────────────────────────────────────────────

export interface IdempotencyRecord {
	key: string;
	/** sha256 of the raw request body — same key + different body → 422. */
	hash: string;
	status: number;
	contentType: string;
	body: string;
	createdAt: number;
}

/** Bounded, TTL'd store (default 24h) for idempotent replays. */
export class IdempotencyStore {
	private readonly recs = new Map<string, IdempotencyRecord>();
	readonly ttlMs: number;
	readonly max: number;
	private readonly now: () => number;

	constructor(opts: { ttlS?: number; max?: number; now?: () => number } = {}) {
		this.ttlMs = (opts.ttlS ?? 86400) * 1000;
		this.max = opts.max ?? 1024;
		this.now = opts.now ?? Date.now;
	}

	get size(): number {
		return this.recs.size;
	}

	get(key: string): IdempotencyRecord | null {
		const rec = this.recs.get(key);
		if (rec === undefined) return null;
		if (this.now() - rec.createdAt > this.ttlMs) {
			this.recs.delete(key);
			return null;
		}
		return rec;
	}

	put(rec: IdempotencyRecord): void {
		// lazy eviction: expired rows go on touch; oldest-inserted row goes
		// when the bound is hit (Map insertion order = FIFO here). createdAt
		// is stamped by the STORE's clock — never the caller's.
		if (this.recs.size >= this.max) {
			const oldest = this.recs.keys().next();
			if (oldest.done !== true) this.recs.delete(oldest.value);
		}
		this.recs.set(rec.key, { ...rec, createdAt: this.now() });
	}
}

/** bodyHashOf — sha256 hex over the raw body text. */
export function bodyHashOf(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

/** Idempotent mutation: reads the Idempotency-Key header, binds the stored
 *  response to the body hash, replays on the same key+body, answers 422 on
 *  the same key with a DIFFERENT body, and stores fresh non-5xx responses.
 *  The handler always receives a Request with an intact (re-wrapped) body. */
export async function idempotentRespond(
	store: IdempotencyStore,
	req: Request,
	run: (req: Request) => Promise<Response> | Response,
): Promise<Response> {
	const key = req.headers.get("idempotency-key");
	const raw = await req.text();
	const rewrapped = new Request(req.url, {
		method: req.method,
		headers: req.headers,
		body: raw,
	});
	if (key === null) return run(rewrapped);
	const hash = bodyHashOf(raw);
	const seen = store.get(key);
	if (seen !== null) {
		if (seen.hash !== hash)
			return toProblemResponse(
				problemOf("validation", {
					code: "buckle.idempotency_body_mismatch",
					why: "idempotency-key was already used with a different body",
				}),
			);
		return new Response(seen.body, {
			status: seen.status,
			headers: {
				"content-type": seen.contentType,
				"idempotency-replayed": "true",
			},
		});
	}
	const resp = await run(rewrapped);
	if (resp.status < 500) {
		store.put({
			key,
			hash,
			status: resp.status,
			contentType: resp.headers.get("content-type") ?? "application/json",
			body: await resp.text(),
			createdAt: 0,
		});
	}
	return resp;
}

// ── (8) per-caller token buckets + bounded shed queue ──────────────────────

/** Token bucket: capacity tokens, refillPerS drip. retryAfterS() is the
 *  time until one token refills (ceiled). */
export class TokenBucket {
	private tokens: number;
	private lastAt: number;
	readonly capacity: number;
	readonly refillPerS: number;
	private readonly now: () => number;

	constructor(opts: {
		capacity: number;
		refillPerS: number;
		now?: () => number;
	}) {
		this.capacity = opts.capacity;
		this.refillPerS = opts.refillPerS;
		this.tokens = opts.capacity;
		this.lastAt = opts.now?.() ?? Date.now();
		this.now = opts.now ?? Date.now;
	}

	private refill(): void {
		const t = this.now();
		const dt = Math.max(0, t - this.lastAt) / 1000;
		this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerS);
		this.lastAt = t;
	}

	tryTake(cost = 1): boolean {
		this.refill();
		if (this.tokens < cost) return false;
		this.tokens -= cost;
		return true;
	}

	/** Seconds until one token exists (ceiled, >= 1). */
	retryAfterS(): number {
		this.refill();
		const need = (1 - this.tokens) / this.refillPerS;
		return Math.max(1, Math.ceil(need));
	}
}

/** One bucket per caller key. */
export class CallerBuckets {
	private readonly buckets = new Map<string, TokenBucket>();
	private readonly capacity: number;
	private readonly refillPerS: number;
	private readonly now: () => number;

	constructor(opts: {
		capacity: number;
		refillPerS: number;
		now?: () => number;
	}) {
		this.capacity = opts.capacity;
		this.refillPerS = opts.refillPerS;
		this.now = opts.now ?? Date.now;
	}

	take(caller: string): { ok: true } | { ok: false; retryAfterS: number } {
		let b = this.buckets.get(caller);
		if (b === undefined) {
			b = new TokenBucket({
				capacity: this.capacity,
				refillPerS: this.refillPerS,
				now: this.now,
			});
			this.buckets.set(caller, b);
		}
		return b.tryTake()
			? { ok: true }
			: { ok: false, retryAfterS: b.retryAfterS() };
	}
}

/** Bounded shed queue with RESERVED HEALTH CAPACITY: capacity - reserved
 *  slots admit normal traffic; past that (or past capacity for health
 *  paths never) — health admits unconditionally and never buckets (a health
 *  probe must never see the shed), shedding answers 503 overloaded
 *  (we-struggle) with a clamped Retry-After, while a per-caller bucket miss
 *  answers 429 rate_limited (you-send-too-much). The distinction IS the
 *  status matrix. */
export class ShedQueue {
	private inflight = 0;
	private readonly buckets: CallerBuckets;
	readonly capacity: number;
	readonly reserved: number;
	private readonly shedRetryAfterS: number;
	private readonly maxRetryAfterS: number | undefined;

	constructor(opts: {
		capacity: number;
		reserved: number;
		buckets: CallerBuckets;
		shedRetryAfterS?: number;
		maxRetryAfterS?: number;
	}) {
		this.capacity = opts.capacity;
		this.reserved = opts.reserved;
		this.buckets = opts.buckets;
		this.shedRetryAfterS = opts.shedRetryAfterS ?? 5;
		this.maxRetryAfterS = opts.maxRetryAfterS;
	}

	get current(): number {
		return this.inflight;
	}

	admit(
		caller: string,
		opts: { health?: boolean } = {},
	):
		| { ok: true; release: () => void }
		| { ok: false; status: 429 | 503; retryAfterS: number } {
		if (opts.health === true) return { ok: true, release: () => {} };
		const t = this.buckets.take(caller);
		if (!t.ok)
			return {
				ok: false,
				status: 429,
				retryAfterS: clampRetryAfter(t.retryAfterS, this.maxRetryAfterS),
			};
		if (this.inflight >= this.capacity - this.reserved)
			return {
				ok: false,
				status: 503,
				retryAfterS: clampRetryAfter(this.shedRetryAfterS, this.maxRetryAfterS),
			};
		this.inflight += 1;
		return {
			ok: true,
			release: () => {
				this.inflight = Math.max(0, this.inflight - 1);
			},
		};
	}
}

// ── (1) URLPattern route table ──────────────────────────────────────────────

export interface RouteInput {
	req: Request;
	url: URL;
	params: Record<string, string>;
}

export type RouteHandler = (
	input: RouteInput,
) => Response | null | Promise<Response | null>;

export interface RouteSpec {
	method: string;
	/** URLPattern pathname syntax — "/v1/admin/keys/:id([0-9a-f]{12})/revoke". */
	pattern: string;
	handler: RouteHandler;
}

/** Canonical Allow ordering (citizenship's grammar: GET, HEAD, OPTIONS). */
const METHOD_ORDER = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
];

/** The family route table: URLPattern matching, HEAD→GET with the body
 *  stripped, automatic OPTIONS 204+Allow, 404 vs 405+Allow decided
 *  structurally (path unknown → null fall-through so the main dispatch
 *  keeps its own terminal 404; path known, method not → 405 problem with
 *  Allow). Handlers may return null to keep an honest fall-through. */
export class RouteTable {
	private readonly routes: {
		method: string;
		pattern: URLPattern;
		handler: RouteHandler;
	}[];
	/** The stable-code prefix for kit-generated 405s (service.slug). */
	private readonly service: string;

	constructor(routes: readonly RouteSpec[], opts?: { service?: string }) {
		this.routes = routes.map((r) => ({
			method: r.method.toUpperCase(),
			pattern: new URLPattern({ pathname: r.pattern }),
			handler: r.handler,
		}));
		this.service = opts?.service ?? "buckle";
	}

	/** Methods available at path ([] when the path matches no pattern). */
	allowAt(path: string): string[] {
		const allow: string[] = [];
		for (const r of this.routes) {
			if (r.pattern.test({ pathname: path }) && !allow.includes(r.method))
				allow.push(r.method);
		}
		return allow;
	}

	/** The Allow header value for the path: canonical order, HEAD riding GET,
	 *  OPTIONS always. */
	allowValueAt(path: string): string | null {
		const allow = this.allowAt(path);
		if (allow.length === 0) return null;
		const set = new Set(allow);
		if (set.has("GET")) set.add("HEAD");
		set.add("OPTIONS");
		return METHOD_ORDER.filter((m) => set.has(m)).join(", ");
	}

	/** Family dispatch. Returns null when the path matches NO pattern (the
	 *  caller falls through to the rest of its dispatch chain). */
	async serve(req: Request, url?: URL): Promise<Response | null> {
		const u = url ?? new URL(req.url);
		const path = u.pathname;
		const allow: string[] = [];
		let handler: RouteHandler | null = null;
		let params: Record<string, string> = {};
		for (const r of this.routes) {
			if (!r.pattern.test({ pathname: path })) continue;
			if (!allow.includes(r.method)) allow.push(r.method);
			const wanted = req.method === "HEAD" ? "GET" : req.method.toUpperCase();
			if (handler === null && r.method === wanted) {
				const m = r.pattern.exec({ pathname: path });
				params = {};
				for (const [k, v] of Object.entries(m?.pathname.groups ?? {}))
					if (typeof v === "string") params[k] = v;
				handler = r.handler;
			}
		}
		if (allow.length === 0) return null;
		if (req.method.toUpperCase() === "OPTIONS")
			return new Response(null, {
				status: 204,
				headers: { allow: this.allowValueAt(path) ?? "OPTIONS" },
			});
		if (handler === null) {
			const allowStr = this.allowValueAt(path) ?? "OPTIONS";
			return toProblemResponse(
				problemOf("method_not_allowed", {
					code: `${this.service}.method_not_allowed`,
					why: `allows: ${allowStr}`,
					instance: path,
					headers: { allow: allowStr },
				}),
			);
		}
		const resp = await handler({ req, url: u, params });
		if (resp === null) return null;
		if (req.method === "HEAD")
			return new Response(null, { status: resp.status, headers: resp.headers });
		return resp;
	}
}
