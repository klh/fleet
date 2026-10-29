// src/resilience.ts — W1303.3 resilience client kit: the standard client
// section as ONE shared face instead of scattered per-router logic (A5/A7/A9
// evidence). Composes with the EXISTING admission/pressure machinery — the
// W1078 ProviderAdmissionCore owns pool pacing (W1273 gap escalation + AIMD
// recovery), cooldown.ts owns ladder benching, the Router walk owns tier
// failover — the kit owns PER-CALL resilience:
//   1. every outbound call carries min(per-call timeout, remaining
//      deadline) via AbortSignal;
//   2. retries only on network/408/429/502/503/504 and safe methods or
//      idempotency-keyed POSTs, full-jitter exponential capped;
//   3. Retry-After honored but CLAMPED;
//   4. retry budget ~10% per upstream (windowed retry/total ratio with a
//      cold-start floor);
//   5. circuit breaker per upstream (closed → open after N consecutive
//      failures → half-open single probe);
//   6. ordered failover that skips open breakers;
//   7. fallback ladder fresh-cache → stale-cache-marked → degraded →
//      unavailable, every step warn-logged.
//
// FAIL FAST (owner correction 2026-10-29 — retry/backoff layers inside the
// gateway multiplied into escalating hangs): resilientCall NEVER sleeps. A
// pacing gate that wants a wait refuses the candidate; a refusal fails over
// at most maxHops times (budgeted) or answers now; only a transport reset
// earns one immediate replay. backoffMs / clampRetryAfterMs stay as the pure
// recipe for the OUTERMOST client — the one retry owner.

/** Minimal response shape the kit classifies; headers when the host has
 *  them (only the idempotency-key probe reads them). */
export interface FailureShape {
	status?: number | null;
	method?: string;
	headers?: { get(name: string): string | null };
}

// ─── 1. Deadline propagation ───
/** Per-call budget = min(per-call timeout, remaining request deadline).
 *  A deadline in the past clamps to the 1ms floor — the attempt fires and
 *  fails fast instead of throwing at the signal constructor. */
export const callDeadlineMs = (
	perCallMs: number,
	deadlineAtMs?: number,
	nowMs = Date.now(),
): number =>
	deadlineAtMs === undefined
		? Math.max(1, perCallMs)
		: Math.max(1, Math.min(Math.max(1, perCallMs), deadlineAtMs - nowMs));

/** The one attempt signal: per-call timeout bounded by the caller's
 *  deadline (and the caller's own abort when present). */
export const attemptSignal = (
	perCallMs: number,
	deadlineAtMs?: number,
	caller?: AbortSignal,
): AbortSignal => {
	const timeout = AbortSignal.timeout(callDeadlineMs(perCallMs, deadlineAtMs));
	return caller ? AbortSignal.any([timeout, caller]) : timeout;
};

// ─── 2. Retryable classification ───
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
	408, 429, 502, 503, 504,
]);

/** HTTP-safe methods — replaying them cannot duplicate a side effect. */
export const SAFE_METHODS: ReadonlySet<string> = new Set([
	"GET",
	"HEAD",
	"OPTIONS",
]);

export const hasIdempotencyKey = (headers?: {
	get(name: string): string | null;
}): boolean => {
	const v =
		headers === undefined
			? null
			: (headers.get("idempotency-key") ?? headers.get("x-idempotency-key"));
	return v !== null && v.trim() !== "";
};

/** Retry only network failures (no status) and 408/429/502/503/504 — and
 *  only when the request side is safe to replay: a safe method or an
 *  idempotency-keyed POST. A plain POST refusal fails over, never replays. */
export const retryableFailure = (f: FailureShape): boolean => {
	if (f.status === undefined || f.status === null) return true;
	if (!RETRYABLE_STATUS.has(f.status)) return false;
	const method = (f.method ?? "GET").toUpperCase();
	return SAFE_METHODS.has(method) || hasIdempotencyKey(f.headers);
};

// ─── 3. Capped full-jitter exponential backoff ───
/** Full jitter: uniform over [0, min(cap, base · 2^attempt)) — the AWS
 *  exponential-backoff blog semantics; the cap bounds the tail, the jitter
 *  de-synchronizes storms. A degenerate rng value clamps into [0,1). */
export const backoffMs = (
	attempt: number,
	capMs: number,
	rng: () => number = Math.random,
	baseMs = 100,
): number => {
	const ceil = Math.min(
		Math.max(1, capMs),
		Math.max(1, baseMs) * 2 ** Math.max(0, Math.min(30, attempt)),
	);
	const r = rng();
	const jitter = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
	return Math.ceil(jitter * ceil);
};

// ─── 4. Retry-After — honored, but CLAMPED ───
/** Retry-After (delta-seconds or HTTP-date) → ms; undefined when absent or
 *  malformed. This is the belt router-core parse, promoted verbatim. */
export const parseRetryAfterHeader = (
	h: string | null | undefined,
	now = Date.now(),
): number | undefined => {
	if (h === null || h === undefined) return undefined;
	const t = h.trim();
	if (t === "") return undefined;
	const s = Number(t);
	if (Number.isFinite(s)) return s >= 0 ? Math.round(s * 1000) : undefined;
	const at = Date.parse(t);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

/** A parsed Retry-After value clamped to the caller cap — a quota wall's
 *  days-long demand never parks the walk (W695.6.1 precedent). */
export const clampRetryAfterMs = (
	rawMs: number | undefined | null,
	capMs: number,
): number | undefined =>
	rawMs === undefined || rawMs === null || !Number.isFinite(rawMs)
		? undefined
		: Math.min(Math.max(0, rawMs), Math.max(0, capMs));

/** Header parse + clamp in one step. */
export const retryAfterHeaderClamped = (
	h: string | null | undefined,
	capMs: number,
	now = Date.now(),
): number | undefined =>
	clampRetryAfterMs(parseRetryAfterHeader(h, now), capMs);

// ─── 5. Retry budget — ~10% per upstream ───
/** Finagle/Envoy-style budget: a sliding window counts total attempts and
 *  retries per upstream; a replay is allowed while
 *   retries < max(minPerWindow, ratio · totals).
 *  minPerWindow keeps a cold upstream retryable before the window has
 *  volume; the ratio caps the amplification an outage may buy. */
export class RetryBudget {
	private readonly rings = new Map<
		string,
		{ attempts: number[]; retried: number[] }
	>();
	private readonly ratio: number;
	private readonly minPerWindow: number;
	private readonly windowMs: number;
	private readonly now: () => number;

	constructor(
		opts: {
			ratio?: number;
			minPerWindow?: number;
			windowMs?: number;
			now?: () => number;
		} = {},
	) {
		this.ratio = opts.ratio ?? 0.1;
		this.minPerWindow = opts.minPerWindow ?? 2;
		this.windowMs = opts.windowMs ?? 60_000;
		this.now = opts.now ?? Date.now;
	}

	private ring(id: string): { attempts: number[]; retried: number[] } {
		let r = this.rings.get(id);
		if (r === undefined) {
			r = { attempts: [], retried: [] };
			this.rings.set(id, r);
		}
		return r;
	}

	/** Windowed counts, pruning timestamps that fell out. */
	private counts(id: string): { total: number; retries: number } {
		const now = this.now();
		const r = this.ring(id);
		const fresh = (ts: number[]) => ts.filter((t) => now - t <= this.windowMs);
		r.attempts = fresh(r.attempts);
		r.retried = fresh(r.retried);
		return { total: r.attempts.length, retries: r.retried.length };
	}

	/** Would a replay be allowed right now for this upstream? */
	canRetry(id: string): boolean {
		const { total, retries } = this.counts(id);
		return (
			retries < Math.max(this.minPerWindow, Math.floor(this.ratio * total))
		);
	}

	/** Record one upstream attempt; `retried` marks replays. */
	record(id: string, retried: boolean): void {
		const now = this.now();
		const r = this.ring(id);
		r.attempts.push(now);
		if (retried) r.retried.push(now);
	}
}

// ─── 6. Circuit breaker — per upstream ───
export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOpts {
	/** Consecutive failures that trip closed → open. */
	failureThreshold?: number;
	/** How long an open breaker stays open before offering ONE probe. */
	openMs?: number;
	now?: () => number;
}

interface BreakerCell {
	state: BreakerState;
	fails: number;
	openedAt: number;
	/** The single half-open probe in flight (never two at once). */
	probeInFlight: boolean;
}

/** Per-upstream breaker: closed until failureThreshold consecutive
 *  failures trip it open; open refuses outright for openMs, then offers
 *  exactly ONE half-open probe — its success closes, its failure re-opens. */
export class Breakers {
	private readonly cells = new Map<string, BreakerCell>();
	private readonly failureThreshold: number;
	private readonly openMs: number;
	private readonly now: () => number;

	constructor(opts: BreakerOpts = {}) {
		this.failureThreshold = opts.failureThreshold ?? 5;
		this.openMs = opts.openMs === undefined ? 30_000 : Math.max(1, opts.openMs);
		this.now = opts.now ?? Date.now;
	}

	private cell(id: string): BreakerCell {
		let c = this.cells.get(id);
		if (c === undefined) {
			c = { state: "closed", fails: 0, openedAt: 0, probeInFlight: false };
		}
		this.cells.set(id, c);
		return c;
	}

	/** The current breaker state for an upstream. */
	state(id: string): BreakerState {
		return this.cell(id).state;
	}

	/** May a wire attempt leave for this upstream right now? An elapsed open
	 *  window transitions to half-open and grants the single probe. */
	canAttempt(id: string): boolean {
		const c = this.cell(id);
		if (c.state === "closed") return true;
		if (c.state === "half-open") return !c.probeInFlight;
		if (this.now() - c.openedAt >= this.openMs) {
			c.state = "half-open";
			c.probeInFlight = true;
			return true;
		}
		return false;
	}

	/** Report a successful attempt — resets the failure streak; the half-open
	 *  probe's success closes the breaker. */
	success(id: string): void {
		const c = this.cell(id);
		c.fails = 0;
		c.state = "closed";
		c.probeInFlight = false;
	}

	/** Report a failed attempt — a half-open probe failure re-opens the
	 *  breaker; a closed breaker trips after the threshold. */
	failure(id: string): void {
		const c = this.cell(id);
		c.probeInFlight = false;
		c.fails++;
		if (c.state === "half-open" || c.fails >= this.failureThreshold) {
			c.state = "open";
			c.openedAt = this.now();
		}
	}
}

// ─── 7. Ordered failover + the cache-fallback ladder ───
export interface Candidate<S> {
	/** Upstream identity — the breaker and budget key. */
	id: string;
	/** ONE wire attempt. Throws = transport failure (status undefined). */
	run: (signal: AbortSignal) => Promise<AttemptResult<S>>;
	/** Request-side classification inputs (default GET). */
	method?: string;
	headers?: { get(name: string): string | null };
}

export interface AttemptResult<S> {
	ok: boolean;
	status?: number;
	/** Provider Retry-After in ms, when the host parsed it. */
	retryAfterMs?: number;
	value?: S;
}

export interface ResilientCallOpts {
	/** Ordered candidates, most-preferred first. */
	candidates: Candidate<unknown>[];
	perCallMs: number;
	deadlineAtMs?: number;
	/** Immediate same-candidate replays for TRANSPORT failures only (a
	 *  reset socket; default 1). A status refusal never replays. */
	maxReplays?: number;
	/** Immediate failover hops after a candidate was knocked (default 1). */
	maxHops?: number;
	breakers?: Breakers;
	/** Caps the immediate hops/replays an upstream's failures may buy. */
	budgets?: RetryBudget;
	/** Pacing gate: a positive wait REFUSES the candidate (fail fast) —
	 *  the kit never sleeps. Returns ms the gate would want, or null. */
	admit?: () => Promise<number | null>;
	log?: (level: "warn" | "info", msg: string) => void;
}

export interface CandidateFailure {
	candidate: string;
	reason: string;
	attempts: number;
	/** The gate's own not-before, for the caller's honest Retry-After. */
	retryAfterMs?: number;
}

export interface ResilientOutcome {
	ok: boolean;
	value?: unknown;
	candidate?: string;
	failures: CandidateFailure[];
}
type KitLog = (level: "warn" | "info", msg: string) => void;

/** One candidate: an attempt plus at most maxReplays IMMEDIATE transport
 *  replays (budgeted). Status refusals return at once. Never a sleep. */
async function knockCandidate(
	c: Candidate<unknown>,
	opts: ResilientCallOpts,
	hopping: boolean,
	log: KitLog,
): Promise<{ ok: true; value: unknown } | { ok: false; failure: CandidateFailure }> {
	const maxReplays = opts.maxReplays ?? 1;
	let attempts = 0;
	while (true) {
		attempts++;
		let result: AttemptResult<unknown> = { ok: false };
		let transport = false;
		try {
			result = await c.run(attemptSignal(opts.perCallMs, opts.deadlineAtMs));
		} catch (error) {
			transport = true;
			log(
				"warn",
				`resilience: ${c.id} transport failure: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		opts.budgets?.record(c.id, attempts > 1 || hopping);
		if (result.ok) {
			opts.breakers?.success(c.id);
			return { ok: true, value: result.value };
		}
		opts.breakers?.failure(c.id);
		const budgetOk = !opts.budgets || opts.budgets.canRetry(c.id);
		if (transport && attempts <= maxReplays && budgetOk) continue;
		const reason = transport ? "transport" : `status ${String(result.status)}`;
		return { ok: false, failure: { candidate: c.id, reason, attempts } };
	}
}
/** Free refusals before any knock: an open breaker, a spent deadline, or
 *  a pacing gate that wants a wait (refused now, never slept). */
async function refuseFast(
	c: Candidate<unknown>,
	opts: ResilientCallOpts,
	log: KitLog,
): Promise<CandidateFailure | null> {
	if (opts.breakers && !opts.breakers.canAttempt(c.id)) {
		log("warn", `resilience: ${c.id} breaker open — skip`);
		return { candidate: c.id, reason: "breaker-open", attempts: 0 };
	}
	if (opts.deadlineAtMs !== undefined && opts.deadlineAtMs <= Date.now())
		return { candidate: c.id, reason: "deadline-exhausted", attempts: 0 };
	const gate = opts.admit ? await opts.admit() : null;
	if (gate === null || gate <= 0) return null;
	log("warn", `resilience: ${c.id} admission refused (${String(gate)}ms)`);
	return {
		candidate: c.id,
		reason: "admission-refused",
		attempts: 0,
		retryAfterMs: gate,
	};
}
/** The composed client, FAIL FAST (owner correction 2026-10-29): ordered
 *  candidates behind per-upstream breakers, deadline-bounded attempts, at
 *  most maxHops immediate failovers (budgeted) — NEVER a sleep. A refusal
 *  is answered now; the outermost client owns the one retry layer. */
export const resilientCall = async (
	opts: ResilientCallOpts,
): Promise<ResilientOutcome> => {
	const log = opts.log ?? (() => {});
	const maxHops = opts.maxHops ?? 1;
	const failures: CandidateFailure[] = [];
	let knocked: string | null = null;
	let hops = 0;
	for (const c of opts.candidates) {
		const refused = await refuseFast(c, opts, log);
		if (refused !== null) {
			failures.push(refused);
			if (refused.reason === "deadline-exhausted") break;
			continue;
		}
		if (knocked !== null) {
			const spent = hops >= maxHops;
			if (spent || (opts.budgets && !opts.budgets.canRetry(knocked))) {
				const reason = spent ? "hop-limit" : "budget-exhausted";
				failures.push({ candidate: c.id, reason, attempts: 0 });
				break;
			}
			hops++;
		}
		const r = await knockCandidate(c, opts, knocked !== null, log);
		if (r.ok) return { ok: true, value: r.value, candidate: c.id, failures };
		failures.push(r.failure);
		knocked = c.id;
	}
	return { ok: false, failures };
};

/** The cache-fallback ladder: walk the ordered sources (fresh-cache →
 *  stale-cache-marked → degraded); a hit at a non-fresh level is served
 *  warn-marked; exhausting the ladder answers unavailable. Every step
 *  taken past fresh-cache is warn-logged. */
export type FallbackLevel = "fresh-cache" | "stale-cache-marked" | "degraded";

export interface FallbackSource<S> {
	level: FallbackLevel;
	load: () => Promise<S | null>;
}

export interface FallbackOutcome<S> {
	level: FallbackLevel | "unavailable";
	value: S | null;
	/** True whenever the answer is NOT a fresh-cache hit. */
	marked: boolean;
}

export const serveFromFallbacks = async <S>(
	sources: FallbackSource<S>[],
	log?: (level: "warn" | "info", msg: string) => void,
): Promise<FallbackOutcome<S>> => {
	for (const s of sources) {
		const v = await s.load();
		if (v !== null && v !== undefined) {
			if (s.level !== "fresh-cache")
				log?.("warn", `resilience: serving ${s.level}`);
			return {
				level: s.level,
				value: v,
				marked: s.level !== "fresh-cache",
			};
		}
		log?.("warn", `resilience: ${s.level} miss — next level`);
	}
	log?.("warn", "resilience: unavailable — every level missed");
	return { level: "unavailable", value: null, marked: true };
};
