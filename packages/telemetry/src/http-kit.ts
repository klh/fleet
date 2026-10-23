// src/http-kit.ts — W1238.5: the ONE shared semantic-error + HTTP-citizenship
// kit. belt/bin/http-citizenship.ts and buckle/src/citizenship.ts delegate to
// this module, so the semantic `kind` rides every problem+json body unchanged
// (service → HTTP → UI): one vocabulary, one wire shape, and the Retry-After
// cap, conditional-request helpers and idempotency replay live HERE, once.
import { stampHopHeaders } from "./http-trace.ts";

// ─── semantic kinds (P8: one kind set, guaranteed to flow unchanged) ───

export type SemanticKind =
	| "rate_limited"
	| "overloaded"
	| "timeout"
	| "network"
	| "auth"
	| "forbidden"
	| "not_found"
	| "method_not_allowed"
	| "state_conflict"
	| "invalid_request"
	| "bad_request"
	| "server";

/** kind → default HTTP status + retryability. The failure-kind rows carry the
 *  W134 §1 ladder values (rate_limited/overloaded/timeout/network/server
 *  retry, auth/bad_request never); client-error kinds never retry. */
export const KINDS: Record<
	SemanticKind,
	{ status: number; retryable: boolean }
> = {
	rate_limited: { status: 429, retryable: true },
	overloaded: { status: 503, retryable: true },
	timeout: { status: 504, retryable: true },
	network: { status: 502, retryable: true },
	server: { status: 500, retryable: true },
	auth: { status: 401, retryable: false },
	forbidden: { status: 403, retryable: false },
	not_found: { status: 404, retryable: false },
	method_not_allowed: { status: 405, retryable: false },
	state_conflict: { status: 409, retryable: false },
	invalid_request: { status: 422, retryable: false },
	bad_request: { status: 400, retryable: false },
};

/** status → default kind. 412 rides state_conflict (a stale If-Match is the
 *  same "your copy is old" semantics as a 409); anything unmapped 5xx →
 *  server, everything else → bad_request (buckle's own fallback rule). */
const STATUS_KIND: Record<number, SemanticKind> = {
	400: "bad_request",
	401: "auth",
	403: "forbidden",
	404: "not_found",
	405: "method_not_allowed",
	409: "state_conflict",
	412: "state_conflict",
	422: "invalid_request",
	429: "rate_limited",
	500: "server",
	502: "network",
	503: "overloaded",
	504: "timeout",
};

export function statusKind(status: number): SemanticKind {
	return STATUS_KIND[status] ?? (status >= 500 ? "server" : "bad_request");
}

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	412: "Precondition Failed",
	422: "Unprocessable Content",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

// ─── problem+json (RFC 9457) — the ONE builder ───

export interface ProblemInput {
	/** Emitter identity — stamps x-klh-service and scopes the refusal code. */
	service: string;
	hop?: string;
	status: number;
	/** Semantic kind; defaults from the status so callers never guess. */
	kind?: SemanticKind;
	/** RFC 9457 title override; defaults to the canonical title for status. */
	title?: string;
	/** Stable service-scoped machine code — <service>.<fine-grained>. Never
	 *  renamed, only added to. */
	code: string;
	/** Human explanation; doubles as the RFC `detail` unless overridden. */
	why: string;
	/** RFC 9457 `detail` override (belt's callers keep detail ≠ why). */
	detail?: string;
	instance?: string;
	/** Machine-actionable recovery steps (fleet extension). */
	next?: string[];
	challenge?: string;
	headers?: Record<string, string>;
}

/** RFC 9457 problem+json with the fleet extensions: `code` (stable machine
 *  code), `why`, `kind` (the semantic kind — identical at every hop) and
 *  `agent_next_steps`. Curated strings only — internals never leak. */
export function problem(p: ProblemInput): Response {
	const kind = p.kind ?? statusKind(p.status);
	const body = {
		type: `/problems/${kind}`,
		title: p.title ?? TITLES[p.status] ?? "Problem",
		status: p.status,
		detail: p.detail ?? p.why,
		...(p.instance === undefined ? {} : { instance: p.instance }),
		code: p.code,
		why: p.why,
		kind,
		...(p.next === undefined ? {} : { agent_next_steps: p.next }),
	};
	const h = new Headers({
		"content-type": "application/problem+json",
		...(p.challenge === undefined ? {} : { "www-authenticate": p.challenge }),
	});
	for (const [k, v] of Object.entries(p.headers ?? {})) h.set(k, v);
	stampHopHeaders(h, {
		service: p.service,
		hop: p.hop,
		refusal: p.code.split(".").pop(),
	});
	return new Response(JSON.stringify(body), { status: p.status, headers: h });
}

// ─── Retry-After — parse + the ONE cap rule ───

/** The shared cap: a Retry-After above this never parks a client (or a lane
 *  walk) for weeks — W695.6.1's rule, now living here, once. */
export const RETRY_AFTER_CAP_S = 300;

/** Retry-After in delta-seconds or HTTP-date form → seconds, or null when
 *  absent/unparseable/negative (a garbage hint is no hint — belt's old rule;
 *  buckle's ladder floors at 0 either way). */
export function parseRetryAfterS(
	value: string | null | Headers,
	now: () => number = Date.now,
): number | null {
	const raw = value instanceof Headers ? value.get("retry-after") : value;
	if (raw === null) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	// numeric → delta form ONLY (a negative hint is no hint; never re-parse
	// numeric garbage as a date — JSC parses "-1" as a year)
	const delta = Number(trimmed);
	if (Number.isFinite(delta)) return delta >= 0 ? delta : null;
	const at = Date.parse(trimmed);
	if (Number.isFinite(at)) return Math.max(0, (at - now()) / 1000);
	return null;
}

/** Clamp to [0, cap] — the rule that keeps quota-wall Retry-Afters from
 *  parking callers. null passes through as null. */
export function capRetryAfterS(
	v: number | null | undefined,
	capS: number = RETRY_AFTER_CAP_S,
): number | null {
	if (v === null || v === undefined) return null;
	return Math.max(0, Math.min(Math.max(0, v), capS));
}

// ─── conditional requests — strong ETag, If-None-Match, If-Match ───

/** Strong ETag: sha256 of the body, first 32 hex, quoted. */
export const etagOf = (body: string): string =>
	`"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;

/** If-None-Match weak comparison (RFC 7232 §2.3): the W/ prefix is ignored
 *  and any list entry (or `*`) matches. */
export const ifNoneMatchHits = (
	header: string | null,
	etag: string,
): boolean => {
	if (header === null) return false;
	const bare = etag.replace(/^W\//, "");
	return header
		.split(",")
		.map((t) => t.trim().replace(/^W\//, ""))
		.some((t) => t === "*" || t === bare);
};

/** If-Match STRONG comparison (RFC 7232 §2.3): a W/ entry never matches —
 *  only an exact strong ETag or `*` passes. */
export const ifMatchHits = (header: string | null, etag: string): boolean => {
	if (header === null) return false;
	return header
		.split(",")
		.map((t) => t.trim())
		.some((t) => t === "*" || t === etag);
};

/** JSON response with a strong ETag; an If-None-Match hit answers 304 with
 *  the ETag echo and no body (the conditional-GET row). */
export const etagJson = (req: Request, body: string): Response => {
	const etag = etagOf(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		etag,
	};
	if (ifNoneMatchHits(req.headers.get("if-none-match"), etag))
		return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers });
};

/** If-Match mismatch → 412 problem+json, kind state_conflict. */
export const preconditionFailed = (
	service: string,
	path: string,
	code?: string,
): Response =>
	problem({
		service,
		status: 412,
		kind: "state_conflict",
		code: code ?? `${service}.precondition_failed`,
		why: "If-Match does not match the current representation",
		instance: path,
	});

// ─── Idempotency-Key — bounded replay for JSON POSTs ───

export interface StoredResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

type Entry = { fp: string; at: number; res: StoredResponse };

/** Bounded replay cache keyed by (Idempotency-Key, request fingerprint). The
 *  ring evicts the oldest entry past `cap`; entries expire after `ttlMs`. */
export class IdempotencyCache {
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly cap = 512,
		private readonly ttlMs = 600_000,
		private readonly now: () => number = Date.now,
	) {}

	private sweep(t: number): void {
		for (const [k, e] of this.entries)
			if (e.at + this.ttlMs <= t) this.entries.delete(k);
	}

	/** Stored response on a hit; "mismatch" when the key was seen with a
	 *  different fingerprint (RFC idempotency: refuse, never replay); null on
	 *  a miss. */
	replay(key: string, fp: string): StoredResponse | "mismatch" | null {
		const t = this.now();
		this.sweep(t);
		const e = this.entries.get(key);
		if (e === undefined) return null;
		if (e.fp !== fp) return "mismatch";
		if (e.at + this.ttlMs <= t) {
			this.entries.delete(key);
			return null;
		}
		return e.res;
	}

	store(key: string, fp: string, res: StoredResponse): void {
		const t = this.now();
		this.sweep(t);
		if (this.entries.size >= this.cap && !this.entries.has(key)) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(key, { fp, at: t, res });
	}
}

/** method + path + body-hash — the fingerprint a reused key must reproduce. */
export const requestFingerprint = (req: Request, bodyText: string): string =>
	`${req.method} ${new URL(req.url).pathname} ${new Bun.CryptoHasher("sha256")
		.update(bodyText)
		.digest("hex")}`;

/** Wrap a JSON POST with Idempotency-Key replay: no key → straight through;
 *  hit → stored response (+ idempotency-replayed: true); key reused with a
 *  different payload → 422 problem; miss → execute, then store the response
 *  when it is JSON and not a 5xx (a 5xx is transient — the client SHOULD
 *  retry for real). Errors/skips (streaming, no body) pass through. */
const DEFAULT_IDEMPOTENCY_CACHE = new IdempotencyCache();

export async function idempotentPost(
	req: Request,
	service: string,
	execute: (replayable: Request) => Promise<Response>,
	cache: IdempotencyCache = DEFAULT_IDEMPOTENCY_CACHE,
): Promise<Response> {
	const key = req.headers.get("idempotency-key");
	if (key === null || key.trim() === "") return execute(req);
	// clone FIRST — a body stream clones only before it is consumed
	const replayable = req.clone();
	let bodyText = "";
	try {
		bodyText = await req.text();
	} catch {
		return execute(replayable);
	}
	const fp = requestFingerprint(req, bodyText);
	const path = new URL(req.url).pathname;
	const hit = cache.replay(key, fp);
	if (hit === "mismatch")
		return problem({
			service,
			status: 422,
			kind: "state_conflict",
			code: `${service}.idempotency_key_reuse`,
			why: "Idempotency-Key reused with a different request payload",
			instance: path,
		});
	if (hit !== null)
		return new Response(hit.body, {
			status: hit.status,
			headers: { ...hit.headers, "idempotency-replayed": "true" },
		});
	replayable.headers.delete("idempotency-key");
	const res = await execute(replayable);
	if (
		res.status < 500 &&
		(res.headers.get("content-type") ?? "").includes("json")
	) {
		const headers = Object.fromEntries(res.headers.entries());
		cache.store(key, fp, {
			status: res.status,
			headers,
			body: await res.clone().text(),
		});
	}
	return res;
}
