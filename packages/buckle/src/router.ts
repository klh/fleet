// src/router.ts — ladder walk + retry + cooldown. Semantics ported from the
// MIT-licensed LiteLLM 1.103.0 core (router.py + router_utils/, pinned-source
// verified W129): ordered cross-group fallback after per-tier retries
// (num_retries), passive outlier ejection (allowed_fails consecutive
// failures → benched for cooldown_time seconds, reset on success), and
// retry-after-honoring backoff with jitter (utils.py::_calculate_retry_after
// semantics: upstream retry-after verbatim when present, capped exponential
// 2**attempt + U[0,1) jitter when absent). Owner directive enforced
// structurally: flashx tiers are refused in every ladder walk.
import {
	type ErrorKind,
	RouterError,
	normalizeUpstreamError,
	routerErrorEnvelope,
} from "./adapters/errors.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { deriveAdapter } from "./adapters/types.ts";
import { bridgeRequest, bridgeResponse } from "./bridge.ts";
import { type CandidateRow, candIdOf } from "./candidates.ts";
import { Cooldowns, retryAfterS, retryDelayS } from "./cooldown.ts";
import { mayEscalate, type RouteSelection } from "./decide.ts";
import { FLASHX, type GatewayPolicy } from "./policy.ts";
import type { TraceContext } from "./trace.ts";
import type { Deployment, Dialect, UpstreamPool } from "./upstreams.ts";

export { FLASHX };

export type ExecuteResult =
	| {
			kind: "upstream";
			response: Response;
			deployment: Deployment;
			candidateId: string; // delivered candidate (W136 audit join)
			tier: string;
			attempts: number;
			stream: boolean;
	  }
	| {
			kind: "client-error";
			response: Response;
			tier: string;
			attempts: number;
	  }
	| {
			kind: "aborted";
	  }
	| {
			kind: "exhausted";
			status: number;
			error: string;
			attempts: number;
	  };

export interface UpstreamRequest {
	group: string;
	dialect: Dialect;
	path: string;
	body: Record<string, unknown>;
	key: string;
	/** W461 stage 1: request-scoped W3C trace context (correlation only —
	 *  never identity/authz). Absent → the wire roots a fresh trace. */
	trace?: TraceContext;
	/** W706: the outbound baggage for a relay leg to a buckle-marked peer
	 *  (origin passed through + peer=self). Absent/non-buckle → the strip. */
	relayBaggage?: string;
	signal?: AbortSignal;
	// W140 routing laws: the pure decision result (handlers decided via the
	// candidate table before dispatch) + the complexity tier + the raw hint,
	// threaded for the escalation gate and audit echo.
	sel?: RouteSelection;
	tier?: string;
	hintRaw?: string;
}

export interface RouterMetrics {
	fallback(tier: string): void;
	cooldown(dep: string): void;
	refused(tier: string): void;
}

/** A single upstream attempt's classified outcome. */
export type TryOutcome =
	| { ok: true; response: Response }
	| {
			ok: false;
			response: Response;
			status: number;
			error: string;
			retryAfterS: number | null;
			clientFault: boolean;
			exhaustTier: boolean;
			/** W134 §1 normalized kind (adapters/errors.ts) */
			kind: ErrorKind;
			/** bad_request subclass: the prompt overflowed this deployment's
			 *  window — fail over (a bigger window may fit), never bench */
			contextWindow: boolean;
	  };

/** Walk state threaded through the ladder. ctxWindow keeps the last
 *  context-window rejection: if every rung overflows, the client gets that
 *  upstream 4xx (actionable) instead of a generic 502. */
interface WalkState {
	attempts: number;
	status: number;
	error: string;
	ctxWindow?: Response;
	rateLimit?: { response: Response; tier: string };
	pendingRetryMs?: number;
}

/** Error bodies are small; never buffer an unbounded one. */
const ERROR_BODY_CAP = 256 * 1024;

async function readCapped(resp: Response): Promise<string> {
	const reader = resp.body?.getReader();
	if (!reader) return "";
	const parts: Uint8Array[] = [];
	let n = 0;
	try {
		while (n < ERROR_BODY_CAP) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			n += value.byteLength;
		}
	} catch {
		// truncated body: classify on what arrived
	} finally {
		reader.cancel().catch(() => {});
	}
	return new TextDecoder().decode(Buffer.concat(parts));
}

/** Non-ok upstream reply → normalized RouterError (status + body signature
 *  + retry-after header/body) and a replayable copy of the response. */
async function classifyFailure(dep: Deployment, resp: Response) {
	const text = await readCapped(resp);
	let wire: unknown = null;
	try {
		wire = JSON.parse(text);
	} catch {
		// non-JSON error body: status-driven classification
	}
	let family: Parameters<typeof normalizeUpstreamError>[0];
	try {
		family = resolveAdapter(dep).family;
	} catch {
		family = deriveAdapter(dep.dialect);
	}
	const err = normalizeUpstreamError(family, resp.status, wire, resp.headers);
	// the body is now decoded text: length/encoding headers no longer apply
	const headers = new Headers(resp.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	const replay = new Response(text, {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
	return { err, replay };
}

/** Thrown when an upstream is unreachable (network/timeout); the walk
 *  catches it and keeps going (ladder), rethrows on caller abort. */
export class UpstreamError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface RouterDeps {
	pool: UpstreamPool;
	// shared ejection state — the candidate table reads the same instance so
	// cooldown-benched deployments go unhealthy in the decision view
	cooldowns?: Cooldowns;
	now?: () => number;
	rng?: () => number;
	sleepMs?: (ms: number) => Promise<void>;
	fetchImpl?: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	) => Promise<Response>;
	metrics?: RouterMetrics;
}

export class Router {
	private readonly cooldowns: Cooldowns;
	private readonly now: () => number;
	private readonly rng: () => number;
	private readonly sleepMs: (ms: number) => Promise<void>;
	private readonly fetchImpl: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	) => Promise<Response>;
	private readonly metrics?: RouterMetrics;

	constructor(
		private readonly policy: GatewayPolicy,
		private readonly deps: RouterDeps,
	) {
		this.cooldowns =
			deps.cooldowns ??
			new Cooldowns(
				policy.allowed_fails ?? 3,
				policy.cooldown_time ?? 30,
				deps.now,
			);
		this.now = deps.now ?? Date.now;
		this.rng = deps.rng ?? Math.random;
		this.sleepMs =
			deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
		this.fetchImpl = deps.fetchImpl ?? defaultFetchImpl;
	}

	/** Same-dialect deployments first (pass-through precedence); the
	 *  bridgeable other-dialect deployments follow — native translation
	 *  (W426), not opt-in failover. Unbridgeable hops (count_tokens, a
	 *  transform that rejects) are skipped, never attempted. */
	private tierCandidates(tier: string, req: UpstreamRequest): Deployment[] {
		const live = this.deps.pool
			.deployments(tier)
			.filter((d) => !this.cooldowns.benched(d));
		const same = live.filter((d) => d.dialect === req.dialect);
		const cross = live.filter(
			(d) => d.dialect !== req.dialect && bridgeRequest(req, d) !== null,
		);
		return [...same, ...cross];
	}

	/** One upstream attempt, outcome classified for the walk. */
	private async tryOnce(
		req: UpstreamRequest,
		dep: Deployment,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	): Promise<TryOutcome> {
		const wireReq = bridgeRequest(req, dep);
		if (wireReq === null)
			throw new UpstreamError(502, `upstream ${dep.url} not bridgeable`);
		const bridged = wireReq !== req;
		try {
			const resp = await this.fetchImpl(dep, wireReq, timeoutMs, stream);
			if (resp.ok) {
				this.cooldowns.success(dep);
				const response = bridged
					? bridgeResponse(resp, req.dialect, req.body.stream === true)
					: resp;
				return { ok: true, response };
			}
			const { err, replay } = await classifyFailure(dep, resp);
			const ra = err.retryAfterS ?? retryAfterS(resp.headers, this.now);
			const base = {
				ok: false as const,
				response:
					err.kind === "rate_limited"
						? Response.json(routerErrorEnvelope(err, req.dialect), {
								status: 429,
								headers: {
									...Object.fromEntries(replay.headers),
									"content-type": "application/json",
									...(ra === null
										? {}
										: {
												"retry-after":
													replay.headers.get("retry-after") ?? String(ra),
											}),
								},
							})
						: replay,
				status: resp.status,
				retryAfterS: ra,
				kind: err.kind,
				contextWindow: err.contextWindow,
			};
			if (bridged && err.kind === "bad_request" && resp.status < 500) {
				// a 4xx on a translated hop may be the bridge's doing and its
				// body speaks the other dialect: skip the hop, never bench it
				return {
					...base,
					contextWindow: false,
					error: `bridged upstream ${dep.url} rejected the request (${String(resp.status)})`,
					clientFault: false,
					exhaustTier: true,
				};
			}
			if (err.contextWindow) {
				// the deployment is healthy, the prompt is too big for it
				return {
					...base,
					error: `upstream ${dep.url} context window exceeded (${String(resp.status)})`,
					clientFault: false,
					exhaustTier: true,
				};
			}
			// a 5xx is the upstream's fault whatever its body claims; 404 is a
			// deployment-level miss (model absent there) — both fail over
			const clientFault =
				err.kind === "bad_request" && resp.status < 500 && resp.status !== 404;
			if (clientFault) {
				// W987: a client-fault rung is THIS deployment refusing the ride
				// (its model/feature set), not the request being unrouteable —
				// bench it and let the walk continue; hard-abort is reserved for
				// req-level faults, which ingress admission owns.
				this.cooldowns.failure(dep);
				this.metrics?.cooldown(`${dep.group}|${dep.url}`);
				return {
					...base,
					error: `upstream ${dep.url} rejected the request (${String(resp.status)})`,
					clientFault: true,
					exhaustTier: false,
				};
			}
			this.cooldowns.failure(
				dep,
				err.kind === "rate_limited" ? "rate_limited" : "other",
			);
			this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			return {
				...base,
				error: `upstream ${dep.url} returned ${String(resp.status)}`,
				clientFault: false,
				// W987: auth rungs (401/403) are deployment faults — the
				// credential belongs to this dep, not the request — so they
				// walk on instead of exhausting the tier (the copilot seat's
				// intermittent 401 vetoed the whole ladder before this).
				exhaustTier: err.kind !== "auth" && !err.retryable,
			};
		} catch (e) {
			if (req.signal?.aborted) throw e;
			this.cooldowns.failure(dep);
			this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			throw new UpstreamError(502, `upstream ${dep.url} unreachable`);
		}
	}

	/** Same-tier retry loop (num_retries + 1 attempts across candidates). */
	private async attemptTier(
		req: UpstreamRequest,
		tier: string,
		candidates: Deployment[],
		st: WalkState,
	): Promise<ExecuteResult | null> {
		const retries = this.policy.num_retries ?? 1;
		const capS = this.policy.retry_max_delay_s ?? 8;
		const floorCapS = this.policy.retry_after_cap_s ?? 60;
		const timeoutMs = (this.policy.request_timeout_s ?? 120) * 1000;
		// W450: streaming bodies get idle+total guards; non-streaming keeps
		// request_timeout_s as its whole-exchange cap (the wire applies it).
		const stream =
			req.body.stream === true
				? {
						idleMs: (this.policy.stream_idle_timeout_s ?? 60) * 1000,
						totalMs: (this.policy.stream_total_timeout_s ?? 900) * 1000,
					}
				: undefined;
		// W987: skip-grade rung failures (auth, client-fault) advance to the
		// next candidate free — the retry budget only buys repeat attempts
		// for failures that can heal (5xx/timeouts/rate limits).
		let skipped = 0;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (req.signal?.aborted) return { kind: "aborted" };
			const raw = attempt + skipped;
			const dep = candidates.at(Math.min(raw, candidates.length - 1));
			if (!dep) break;
			if (st.pendingRetryMs !== undefined) {
				await this.sleepMs(st.pendingRetryMs);
				st.pendingRetryMs = undefined;
				if (req.signal?.aborted) return { kind: "aborted" };
			}
			st.attempts++;
			let r: TryOutcome;
			try {
				r = await this.tryOnce(req, dep, timeoutMs, stream);
			} catch (error) {
				if (req.signal?.aborted) return { kind: "aborted" };
				if (!(error instanceof UpstreamError)) throw error;
				// W985 skip-not-fail: an unreachable rung (ECONNREFUSED, timeout)
				// must not kill the ladder — record it and walk on to the next
				// candidate / fallback rung. A banked provider rate limit still
				// outranks the dead hop: end the tier, its 429 answers at
				// exhausted() verbatim.
				if (st.rateLimit) break;
				st.status = error.status;
				st.error = `no healthy upstream for ${req.group} (${error.message})`;
				continue;
			}
			if (r.ok) {
				return {
					kind: "upstream",
					response: r.response,
					deployment: dep,
					candidateId: candIdOf(dep),
					tier,
					attempts: st.attempts,
					stream: req.body.stream === true,
				};
			}
			st.status = r.status;
			st.error = r.error;
			if (r.kind === "rate_limited" && !st.rateLimit)
				st.rateLimit = { response: r.response, tier };
			if (r.contextWindow) st.ctxWindow = r.response;
			if (r.exhaustTier) break;
			// A provider that asks us to wait beyond the configured retry cap is
			// quota-blocked. Retrying the same deployment cannot heal within this
			// walk; try another deployment or the policy fallback immediately.
			// Keep its 429 in st.rateLimit for an exhausted ladder to relay.
			if (
				r.kind === "rate_limited" &&
				r.retryAfterS !== null &&
				r.retryAfterS > floorCapS
			) {
				if (raw + 1 >= candidates.length) break;
				skipped++;
				continue;
			}
			// W987: an auth/client-fault rung failed on THIS deployment (its
			// credential or its model) — the bench already happened in
			// tryOnce; advance to the next candidate free (no retry budget,
			// no backoff sleep).
			if (r.clientFault || r.kind === "auth") {
				if (raw + 1 >= candidates.length) break;
				skipped++;
				continue;
			}
			st.pendingRetryMs =
				retryDelayS(st.attempts - 1, r.retryAfterS, this.rng, capS, floorCapS) *
				1000;
		}
		return null;
	}

	/** A temporarily ejected rate-limited tier still has an actionable
	 * outcome. The response is synthetic: a previous provider body must not
	 * be replayed into a different request. */
	private rememberCooledRateLimit(
		tier: string,
		req: UpstreamRequest,
		st: WalkState,
	): void {
		if (st.rateLimit) return;
		const remaining = this.deps.pool
			.deployments(tier)
			.filter((dep) => bridgeRequest(req, dep) !== null)
			.map((dep) => this.cooldowns.rateLimitRemainingS(dep))
			.filter((seconds): seconds is number => seconds !== null);
		if (remaining.length === 0) return;
		const retryAfter = Math.min(...remaining);
		const error = new RouterError(
			"rate_limited",
			429,
			"Upstream rate limited; retry after cooldown",
		);
		st.rateLimit = {
			tier,
			response: Response.json(routerErrorEnvelope(error, req.dialect), {
				status: 429,
				headers: { "retry-after": String(retryAfter) },
			}),
		};
	}

	/** Ladder walk: requested group first, then the policy fallback list.
	 *  flashx tiers are refused (owner directive); dormant groups (zero
	 *  matching deployments — e.g. cloud tiers with no BUCKLE_UPSTREAMS
	 *  override) are skipped as skip-not-failure. */
	async execute(req: UpstreamRequest): Promise<ExecuteResult> {
		if (req.signal?.aborted) return { kind: "aborted" };
		if (req.sel)
			return this.walkSelected(req, {
				attempts: 0,
				status: 502,
				error: `no healthy upstream for ${req.group}`,
			});
		const st: WalkState = {
			attempts: 0,
			status: 502,
			error: `no healthy upstream for ${req.group}`,
		};
		const tiers = [req.group, ...(this.policy.fallbacks?.[req.group] ?? [])];
		for (const tier of tiers) {
			if (FLASHX.test(tier)) {
				this.metrics?.refused(tier);
				continue;
			}
			const candidates = this.tierCandidates(tier, req);
			if (candidates.length === 0) {
				this.rememberCooledRateLimit(tier, req, st);
				continue;
			}
			if (tier !== req.group) this.metrics?.fallback(tier);
			const r = await this.attemptTier(req, tier, candidates, st);
			if (r !== null) return r;
		}
		return exhausted(st);
	}

	/** W140 selection walk: deliver the selected candidate first, then the
	 *  policy ladder as the failure domain. must (full fit) keeps its domain
	 *  closed — ladder rungs would substitute beyond the hint (law 2). */
	private async walkSelected(
		req: UpstreamRequest,
		st: WalkState,
	): Promise<ExecuteResult> {
		const sel = req.sel;
		if (!sel) return exhausted(st); // unreachable (guarded)
		const tried = new Set<string>();
		// Unbridgeable rows (count_tokens on an openai row, a transform that
		// rejects) are skipped, never attempted — skip-not-fail.
		const ordered = sel.ordered.filter(
			(row) => bridgeRequest(req, row.dep) !== null,
		);
		// The escalation law owns EVERY prefer/no-hint cloud delivery: the
		// hint ranks the head, it does not authorize leaving the machine
		// (W136 §5.2 — prefs AND tier-warrant AND failed-twice, all AND-ed).
		// Only must's demanded set bypasses the ESCALATION legs (tier-warrant
		// and failed-twice — the demand is the warrant, W209); the owner
		// prefs still bind it (precedence 1, W709/W694 H3: prefs > hint >
		// tier). An empty-demand must (total=0) is not a demanded set and
		// does not ride the exemption either.
		const demanded = sel.verb === "must" && sel.total > 0;
		const prefsOpen = sel.prefs.allow_cloud && sel.prefs.cost_speed !== "cost";
		const gate = (row: CandidateRow): boolean =>
			row.kind === "cloud" &&
			(demanded
				? !prefsOpen
				: row.group === req.group && prefsOpen
					? false // an explicit model pin is the cloud warrant
					: !mayEscalate({
							group: row.group,
							tier: req.tier,
							attempts: st.attempts,
							prefs: sel.prefs,
							cloudGroups: sel.cloudGroups,
						}));
		for (const row of ordered) {
			if (req.signal?.aborted) return { kind: "aborted" };
			if (gate(row)) continue;
			if (this.cooldowns.rateLimitRemainingS(row.dep) !== null) {
				this.rememberCooledRateLimit(row.group, req, st);
				continue;
			}
			tried.add(row.candidate_id);
			const r = await this.attemptTier(req, row.group, [row.dep], st);
			if (r !== null) return r;
		}
		if (sel.verb === "must" && sel.fit === sel.total && sel.total > 0) {
			// must-domain closed: no substitution beyond the hint (law 2)
			return exhausted(st);
		}
		return this.gatedLadder(req, sel, st, tried);
	}

	/** Ladder rungs after selection: flashx refused, cloud rungs fire only
	 *  under the W136 escalation law (allow_cloud, not cost mode, tier
	 *  warrants or quality, local failed twice). */
	private async gatedLadder(
		req: UpstreamRequest,
		sel: RouteSelection,
		st: WalkState,
		tried: Set<string>,
	): Promise<ExecuteResult> {
		const tiers = [req.group, ...(this.policy.fallbacks?.[req.group] ?? [])];
		for (const tier of tiers) {
			if (FLASHX.test(tier)) {
				this.metrics?.refused(tier);
				continue;
			}
			if (
				sel.cloudGroups.has(tier) &&
				!mayEscalate({
					group: tier,
					tier: req.tier,
					attempts: st.attempts,
					prefs: sel.prefs,
					cloudGroups: sel.cloudGroups,
				})
			)
				continue; // gate closed: SIMPLE/MEDIUM never leave the machine
			const candidates = this.tierCandidates(tier, req).filter(
				(d) => !tried.has(candIdOf(d)),
			);
			if (candidates.length === 0) {
				this.rememberCooledRateLimit(tier, req, st);
				continue;
			}
			if (tier !== req.group) this.metrics?.fallback(tier);
			const r = await this.attemptTier(req, tier, candidates, st);
			if (r !== null) return r;
		}
		return exhausted(st);
	}
}

/** End of a walk with nothing delivered: an all-rungs context-window
 *  overflow answers the upstream's 4xx; anything else is exhausted. */
function exhausted(st: WalkState): ExecuteResult {
	if (st.rateLimit)
		return {
			kind: "client-error",
			response: st.rateLimit.response,
			tier: st.rateLimit.tier,
			attempts: st.attempts,
		};
	if (st.ctxWindow)
		return {
			kind: "client-error",
			response: st.ctxWindow,
			tier: "",
			attempts: st.attempts,
		};
	return {
		kind: "exhausted",
		status: st.status,
		error: st.error,
		attempts: st.attempts,
	};
}

async function defaultFetchImpl(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
	stream?: { idleMs: number; totalMs: number },
): Promise<Response> {
	const { defaultFetch } = await import("./wire.ts");
	return defaultFetch(dep, req, timeoutMs, stream);
}
