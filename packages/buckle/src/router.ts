// src/router.ts — ladder walk + retry + cooldown. Semantics ported from the
// MIT-licensed LiteLLM 1.103.0 core (router.py + router_utils/, pinned-source
// verified W129): ordered cross-group fallback after per-tier retries
// (num_retries), passive outlier ejection (allowed_fails consecutive
// failures → benched for cooldown_time seconds, reset on success), and
// retry-after-honoring backoff with jitter (utils.py::_calculate_retry_after
// semantics: upstream retry-after verbatim when present, capped exponential
// 2**attempt + U[0,1) jitter when absent). Owner directive enforced
// structurally: flashx tiers are refused in every ladder walk.
import { createHash } from "node:crypto";
import {
	type HopReceipt,
	safeCorrelationId,
	safeProviderErrorToken,
	safeRefusalCode,
	traceIdOf,
} from "../../telemetry/src/http-trace.ts";
import {
	safeTimeoutPhase,
	TransportObservation,
} from "../../telemetry/src/transport-evidence.ts";
import { RouterError, routerErrorEnvelope } from "./adapters/errors.ts";
import { bridgeRequest, bridgeResponse } from "./bridge.ts";
import { type CandidateRow, candIdOf } from "./candidates.ts";
import { Cooldowns, retryAfterS, retryDelayS } from "./cooldown.ts";
import { mayEscalate, type RouteSelection } from "./decide.ts";
import { FLASHX, type GatewayPolicy } from "./policy.ts";
import {
	bindProviderLease,
	ProviderAdmissionCore,
	ProviderAdmissionFull,
	type ProviderLease,
	providerPressureOf,
} from "./provider-admission-core.ts";
import type { Deployment, UpstreamPool } from "./upstreams.ts";
import { HubConnectError } from "./wire.ts";
import type {
	ExecuteResult,
	RouterMetrics,
	TryOutcome,
	UpstreamRequest,
	WalkState,
} from "./router-types.ts";
import {
	UpstreamError,
	admissionRefusal,
	classifyFailure,
	defaultFetchImpl,
	exhausted,
	providerConcurrencyCodesOf,
	providerPoolIdOf,
} from "./router-outcome.ts";

export { FLASHX };
export type {
	ExecuteResult,
	RouterMetrics,
	TryOutcome,
	UpstreamRequest,
	WalkState,
} from "./router-types.ts";
export {
	UpstreamError,
	providerPoolIdOf,
} from "./router-outcome.ts";

export interface RouterDeps {
	pool: UpstreamPool;
	// shared ejection state — the candidate table reads the same instance so
	// cooldown-benched deployments go unhealthy in the decision view
	cooldowns?: Cooldowns;
	now?: () => number;
	rng?: () => number;
	sleepMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
	fetchImpl?: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	) => Promise<Response>;
	metrics?: RouterMetrics;
	/** W1077: injectable liveness probe (tests stub it; default = a plain
	 *  GET /v1/models where any HTTP answer counts as live). */
	probe?: (dep: Deployment, signal?: AbortSignal) => Promise<Response | null>;
}

export class Router {
	private readonly cooldowns: Cooldowns;
	private readonly now: () => number;
	private readonly rng: () => number;
	private readonly sleepMs: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly fetchImpl: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	) => Promise<Response>;
	private readonly metrics?: RouterMetrics;
	/** W1078: one admission core per explicitly configured account pool —
	 *  every deployment bound to the id shares the SAME instance (one
	 *  configured authority counts each actual provider attempt once). */
	private readonly pools: Map<string, ProviderAdmissionCore>;

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
			deps.sleepMs ??
			((ms, signal) =>
				new Promise((resolve) => {
					if (signal?.aborted) return resolve();
					const timer = setTimeout(resolve, ms);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				}));
		this.fetchImpl = deps.fetchImpl ?? defaultFetchImpl;
		this.metrics = deps.metrics;
		// W1078: instantiate one core per explicitly configured account pool.
		// Bindings validate fail-closed here: a deployment bound to a pool
		// with no policy (or a malformed id) refuses startup — admission is
		// never silently disabled once configured.
		this.pools = new Map(
			Object.entries(policy.provider_pools ?? {}).map(([id, p]) => [
				id,
				new ProviderAdmissionCore(p),
			]),
		);
		for (const group of deps.pool.groups())
			for (const dep of deps.pool.deployments(group)) {
				providerConcurrencyCodesOf(dep, policy);
				if (dep.adapter_config?.provider_pool === undefined) continue;
				const id = providerPoolIdOf(dep);
				if (id === null || !this.pools.has(id))
					throw new Error(
						`router: deployment ${dep.group}/${dep.url} binds provider_pool "${String(dep.adapter_config?.provider_pool)}" with no matching gateway.provider_pools policy (W1078 admission is fail-closed)`,
					);
			}
	}

	/** Same-dialect deployments first (pass-through precedence); the
	 *  bridgeable other-dialect deployments follow — native translation
	 *  (W426), not opt-in failover. Unbridgeable hops (count_tokens, a
	 *  transform that rejects) are skipped, never attempted. */
	private tierCandidates(tier: string, req: UpstreamRequest): Deployment[] {
		const live = this.deps.pool
			.deployments(tier)
			.filter((d) => !this.cooldowns.benched(d));
		// W1124.27: same-dialect is no longer auto-eligible — a chatgpt rung
		// whose body the native bridge refuses is skipped like any
		// unbridgeable hop (skip-not-fail), falling to the next rung verbatim.
		const same = live.filter(
			(d) => d.dialect === req.dialect && bridgeRequest(req, d) !== null,
		);
		const cross = live.filter(
			(d) => d.dialect !== req.dialect && bridgeRequest(req, d) !== null,
		);
		return [...same, ...cross];
	}

	providerAdmissionSnapshot() {
		return Object.fromEntries(
			[...this.pools].map(([id, core]) => [id, core.snapshot()]),
		);
	}
	/** One upstream attempt, outcome classified for the walk. */
	private async tryOnce(
		req: UpstreamRequest,
		dep: Deployment,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
		walkRemainingMs = timeoutMs,
	): Promise<TryOutcome> {
		const wireReq = bridgeRequest(req, dep);
		if (wireReq === null)
			throw new UpstreamError(502, `upstream ${dep.url} not bridgeable`);
		// W1124.27: "bridged" means the DIALECT changed — a same-dialect body
		// normalize (chatgpt seam) returns a new req object but the response
		// speaks this dialect, so it must not be re-framed or its refusals
		// re-attributed as bridge artifacts.
		const bridged = wireReq.dialect !== req.dialect;
		// W1078: admission at the selected-attempt seam — after bridge
		// eligibility, before the fetch. The queue wait is capped by the
		// remaining walk budget (deadlines only shrink); a granted lease
		// clears the wait timer, so active streams keep their own guards.
		const poolId = providerPoolIdOf(dep);
		const admission = poolId === null ? undefined : this.pools.get(poolId);
		let lease: ProviderLease | undefined;
		let queueWaitMs = 0;
		if (admission !== undefined && poolId !== null) {
			const queuedAt = this.now();
			try {
				// Admission may use its configured wait inside the remaining
				// walk, leaving a minimum fetch opportunity. The network timeout
				// is an upper bound, never a second budget beyond the walk.
				lease = await admission.acquire(
					req.signal,
					Math.max(1, walkRemainingMs - 1),
				);
			} catch (error) {
				if (req.signal?.aborted) throw error;
				const expired = error instanceof Error && error.name === "TimeoutError";
				if (error instanceof ProviderAdmissionFull || expired) {
					return admissionRefusal(
						dep,
						this.policy.provider_pools?.[poolId],
						error instanceof ProviderAdmissionFull ? "full" : "expired",
						poolId,
						Math.max(0, Math.round(this.now() - queuedAt)),
					);
				}
				throw error;
			}
			queueWaitMs = Math.max(0, Math.round(this.now() - queuedAt));
			const remainingMs = walkRemainingMs - queueWaitMs;
			if (remainingMs <= 0) {
				lease.release();
				return admissionRefusal(
					dep,
					this.policy.provider_pools?.[poolId],
					"expired",
					poolId,
					queueWaitMs,
				);
			}
			timeoutMs = Math.min(timeoutMs, remainingMs);
		}
		try {
			const raw = await this.fetchImpl(dep, wireReq, timeoutMs, stream);
			const resp = lease === undefined ? raw : bindProviderLease(raw, lease);
			if (resp.ok) {
				this.cooldowns.success(dep);
				const response = bridged
					? bridgeResponse(resp, req.dialect, req.body.stream === true)
					: resp;
				// W1078 canary metadata (body-free, set AFTER the bridge so both
				// dialects preserve it): proves which configured pool served the
				// alias and separates queue dwell from provider latency. Local
				// refusal metadata stays typed-local (never this header path).
				if (lease !== undefined && poolId !== null) {
					response.headers.set("x-klh-provider-pool", poolId);
					response.headers.set(
						"x-klh-provider-queue-wait-ms",
						String(queueWaitMs),
					);
				}
				return {
					ok: true,
					response,
					providerPool: poolId,
					queueWaitMs: lease ? queueWaitMs : null,
				};
			}
			const { err, replay, requestId, callId } = await classifyFailure(
				dep,
				resp,
			);
			const ra = err.retryAfterS ?? retryAfterS(resp.headers, this.now);
			const pressure = providerPressureOf(
				{ concurrencyErrorCodes: providerConcurrencyCodesOf(dep, this.policy) },
				err.providerCode,
			);
			lease?.feedback?.(resp.status, ra, pressure);
			const base = {
				transportTimeoutPhase: dep.buckle
					? safeTimeoutPhase(resp.headers.get("x-klh-transport-timeout-phase"))
					: null,
				providerPool: poolId,
				queueWaitMs: lease ? queueWaitMs : null,
				providerErrorCode: safeProviderErrorToken(err.providerCode),
				providerErrorType: safeProviderErrorToken(err.providerType),
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
				refusalSource: "upstream" as const,
				requestId,
				callId,
				upstreamRefusalCode: safeRefusalCode(resp.headers.get("x-klh-refusal")),
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
					refusalSource: "bridged-upstream",
				};
			}
			if (err.contextWindow) {
				// the deployment is healthy, the prompt is too big for it
				return {
					...base,
					error: `upstream ${dep.url} context window exceeded (${String(resp.status)})`,
					clientFault: false,
					exhaustTier: true,
					refusalSource: "upstream",
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
					refusalSource: "upstream",
				};
			}
			// Account occupancy is not deployment health. Keep the real refusal
			// and provider Retry-After; never synthesize an outage/cooldown for it.
			if (!(resp.status === 429 && pressure === "concurrency")) {
				this.cooldowns.failure(
					dep,
					err.kind === "rate_limited" ? "rate_limited" : "other",
				);
				this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			}
			return {
				...base,
				error: `upstream ${dep.url} returned ${String(resp.status)}`,
				clientFault: false,
				refusalSource: "upstream",
				// W987: auth rungs (401/403) are deployment faults — the
				// credential belongs to this dep, not the request — so they
				// walk on instead of exhausting the tier (the copilot seat's
				// intermittent 401 vetoed the whole ladder before this).
				exhaustTier: err.kind !== "auth" && !err.retryable,
			};
		} catch (e) {
			// W1078: no Response exists to hold the lease — release before any
			// classification/wrap so a failed fetch never leaks its slot.
			lease?.release();
			if (req.signal?.aborted) throw e;
			const connectFailure = e instanceof HubConnectError;
			const timedOut =
				(e instanceof Error && e.name === "TimeoutError") ||
				(e instanceof UpstreamError && e.timedOut);
			if (connectFailure) this.cooldowns.eject(dep);
			else this.cooldowns.failure(dep);
			this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			throw new UpstreamError(
				502,
				`upstream ${dep.url} unreachable`,
				connectFailure ? "connect" : "upstream",
				timedOut,
				poolId,
				lease ? queueWaitMs : null,
			);
		}
	}

	/** One bounded receipt per actual candidate attempt. Telemetry failures
	 * cannot change routing, and candidate IDs never expose a raw URL. */
	private reportAttempt(
		req: UpstreamRequest,
		dep: Deployment,
		ordinal: number,
		startedAt: number,
		status: number | null,
		refusal: string | null,
		retryAfterS: number | null,
		requestId?: string,
		callId?: string,
		upstreamRefusalCode: string | null = null,
		refusalOrigin: HopReceipt["refusalOrigin"] = null,
		provider?: Pick<
			TryOutcome,
			"providerPool" | "queueWaitMs" | "providerErrorCode" | "providerErrorType"
		>,
	): void {
		const retryAfterMs =
			retryAfterS === null || !Number.isFinite(retryAfterS)
				? null
				: Math.min(
						Number.MAX_SAFE_INTEGER,
						Math.max(0, Math.round(retryAfterS * 1000)),
					);
		const receipt: HopReceipt = {
			rid: req.rid ?? "",
			traceId: traceIdOf(req.trace?.traceparent ?? null) ?? "",
			ordinal,
			service: "buckle",
			hop:
				refusalOrigin === "local-admission"
					? "local-admission"
					: dep.dialect === req.dialect
						? "upstream"
						: "bridged-upstream",
			candidate: createHash("sha256")
				.update(candIdOf(dep))
				.digest("hex")
				.slice(0, 16),
			status,
			refusal,
			durationMs: Math.max(0, this.now() - startedAt),
			retryAfterMs,
			upstreamId: requestId ?? null,
			callId: callId ?? null,
			upstreamRefusalCode,
			refusalOrigin,
			providerErrorCode: safeProviderErrorToken(provider?.providerErrorCode),
			providerErrorType: safeProviderErrorToken(provider?.providerErrorType),
			...{
				providerPool: provider?.providerPool ?? providerPoolIdOf(dep),
				queueWaitMs: provider?.queueWaitMs ?? null,
			},
		};
		const publish = () => {
			try {
				this.metrics?.attempt?.({
					...receipt,
					transport: req.transport?.snapshot() ?? null,
				});
			} catch {
				// The receipt sink is observability, never a routing dependency.
			}
		};
		req.transport?.bind(publish);
		publish();
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
		const perAttemptMs = (this.policy.request_timeout_s ?? 120) * 1000;
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
		const timedOutOrigins = new Set<string>();
		let pendingRetry: { candidateId: string; delayMs: number } | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (req.signal?.aborted) return { kind: "aborted" };
			if (this.walkExpired(st)) break;
			const raw = attempt + skipped;
			const nextIndex = candidates.findIndex(
				(candidate, index) =>
					index >= Math.min(raw, candidates.length - 1) &&
					!timedOutOrigins.has(new URL(candidate.url).origin) &&
					!st.unavailablePools?.has(providerPoolIdOf(candidate) ?? ""),
			);
			if (nextIndex > raw) skipped += nextIndex - raw;
			const dep = nextIndex < 0 ? undefined : candidates[nextIndex];
			if (!dep) break;
			if (pendingRetry?.candidateId === candIdOf(dep)) {
				const remainingMs = st.deadlineMs - this.now();
				// Retry-After constrains this candidate only. A healthy fallback
				// must get the remaining budget instead of waiting it away.
				if (pendingRetry.delayMs >= remainingMs) break;
				await this.waitBeforeRetry(
					pendingRetry.delayMs,
					req.signal,
					remainingMs,
				);
				if (req.signal?.aborted) return { kind: "aborted" };
				if (this.walkExpired(st)) break;
			}
			pendingRetry = undefined;
			const timeoutMs = Math.max(
				1,
				Math.min(perAttemptMs, st.deadlineMs - this.now()),
			);
			st.attempts++;
			const startedAt = this.now();
			const observedReq = { ...req, transport: new TransportObservation() };
			let r: TryOutcome;
			try {
				r = await this.tryOnce(
					observedReq,
					dep,
					timeoutMs,
					stream,
					st.deadlineMs - startedAt,
				);
			} catch (error) {
				if (req.signal?.aborted) {
					this.reportAttempt(
						observedReq,
						dep,
						st.attempts,
						startedAt,
						null,
						"downstream_cancel",
						null,
					);
					return { kind: "aborted" };
				}
				if (!(error instanceof UpstreamError)) throw error;
				if (error.timedOut) {
					timedOutOrigins.add(new URL(dep.url).origin);
					if (error.providerPool !== null && (error.queueWaitMs ?? 0) > 0) {
						st.unavailablePools ??= new Set();
						st.unavailablePools.add(error.providerPool);
					}
				}
				this.reportAttempt(
					observedReq,
					dep,
					st.attempts,
					startedAt,
					null,
					error.layer === "connect" ? "connect_unreachable" : "network",
					error.layer === "connect" ? this.cooldowns.remainingS(dep) : null,
					undefined,
					undefined,
					null,
					"network",
					error,
				);
				// W985 skip-not-fail: an unreachable rung (ECONNREFUSED, timeout)
				// must not kill the ladder — record it and walk on to the next
				// candidate / fallback rung. A banked provider rate limit still
				// outranks the dead hop: end the tier, its 429 answers at
				// exhausted() verbatim.
				if (st.rateLimit) break;
				st.status = error.status;
				st.error = `no healthy upstream for ${req.group} (${error.message})`;
				st.lastFailure = {
					source: "network",
					status: error.status,
					kind: "network",
					transportTimeoutPhase:
						observedReq.transport.snapshot()?.timeoutPhase ?? null,
				};
				// A failed network exchange already spent this row's entire
				// request timeout. Repeating the same last row cannot improve
				// this walk; hand the remaining time to the next policy tier.
				if (nextIndex >= candidates.length - 1) break;
				continue;
			}
			if (r.ok) {
				const upstreamId = safeCorrelationId(
					r.response.headers.get("x-request-id") ??
						r.response.headers.get("x-klh-upstream-request-id"),
				);
				const callId = safeCorrelationId(
					r.response.headers.get("x-litellm-call-id"),
				);
				this.reportAttempt(
					observedReq,
					dep,
					st.attempts,
					startedAt,
					r.response.status,
					null,
					null,
					upstreamId,
					callId,
					null,
					null,
					r,
				);
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
			if ("localAdmission" in r) {
				const account = providerPoolIdOf(dep);
				if (account !== null) {
					st.unavailablePools ??= new Set();
					st.unavailablePools.add(account);
				}
				this.reportAttempt(
					observedReq,
					dep,
					st.attempts,
					startedAt,
					r.status,
					"local_admission",
					r.retryAfterS,
					undefined,
					undefined,
					null,
					"local-admission",
					r,
				);
				// W1078 skip-grade: the local account pool is shared across the
				// tier's rows, so repeating a refused row inside this tier cannot
				// heal — advance to the next candidate / fallback rung FREE (no
				// bench, no cooldown metric, no retry budget, no rate-limit
				// memory). The refusal becomes the walk's lastFailure, so an
				// exhausted ladder answers 503 + window-derived Retry-After.
				st.status = r.status;
				st.error = r.error;
				st.lastFailure = {
					source: "local-admission",
					status: r.status,
					kind: "local_admission",
					retryAfterS: r.retryAfterS,
				};
				if (raw + 1 >= candidates.length) break;
				skipped++;
				continue;
			}
			this.reportAttempt(
				observedReq,
				dep,
				st.attempts,
				startedAt,
				r.status,
				r.kind,
				r.retryAfterS,
				r.requestId,
				r.callId,
				r.upstreamRefusalCode ?? null,
				r.refusalSource,
				r,
			);
			st.status = r.status;
			st.error = r.error;
			st.lastFailure = {
				source: r.refusalSource,
				status: r.status,
				kind: r.kind,
				transportTimeoutPhase: r.transportTimeoutPhase,
				requestId: r.requestId,
				callId: r.callId,
				upstreamRefusalCode: r.upstreamRefusalCode ?? null,
				retryAfterS:
					r.retryAfterS === null
						? undefined
						: Math.max(
								1,
								Math.min(Math.ceil(r.retryAfterS), Math.max(1, floorCapS)),
							),
			};
			if (this.walkExpired(st)) break;
			if (r.kind === "network" || r.kind === "timeout") {
				// A peer transport failure has the same walk semantics as a
				// local fetch timeout. Do not queue its account again after
				// already spending admission dwell; independent tiers need
				// the remainder of the original first-byte budget.
				timedOutOrigins.add(new URL(dep.url).origin);
				const account = providerPoolIdOf(dep);
				if (account !== null && (r.queueWaitMs ?? 0) > 0) {
					st.unavailablePools ??= new Set();
					st.unavailablePools.add(account);
				}
				continue;
			}
			if (r.kind === "rate_limited") {
				if (!st.rateLimit)
					st.rateLimit = { response: r.response, tier, source: "upstream" };
				// An explicit provider not-before applies to every alias of the
				// account. Skip it within this walk; the shared core retains the
				// backoff for subsequent requests. Without Retry-After, keep the
				// configured adaptive retry policy for transient burst feedback.
				const account = providerPoolIdOf(dep);
				if (account !== null && r.retryAfterS !== null && r.retryAfterS > 0) {
					st.unavailablePools ??= new Set();
					st.unavailablePools.add(account);
				}
			}
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
			if (attempt < retries)
				pendingRetry = {
					candidateId: candIdOf(dep),
					delayMs:
						retryDelayS(
							st.attempts - 1,
							r.retryAfterS,
							this.rng,
							capS,
							floorCapS,
						) * 1000,
				};
		}
		return null;
	}

	private walkExpired(st: WalkState): boolean {
		if (this.now() < st.deadlineMs) return false;
		st.status = 504;
		st.error = "Buckle first-byte walk deadline exceeded";
		st.lastFailure = { source: "network", status: 504, kind: "walk_deadline" };
		return true;
	}

	private async waitBeforeRetry(
		ms: number,
		signal: AbortSignal | undefined,
		remainingMs: number,
	): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), remainingMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) controller.abort();
		try {
			const aborted = controller.signal.aborted
				? Promise.resolve()
				: new Promise<void>((resolve) =>
						controller.signal.addEventListener("abort", () => resolve(), {
							once: true,
						}),
					);
			await Promise.race([this.sleepMs(ms, controller.signal), aborted]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			controller.abort();
		}
	}

	/** W1077: one cheap liveness probe against a benched leg. Any HTTP
	 *  response (even 401/404 - the leg ANSWERS) proves liveness: clear the
	 *  bench and hand the leg back for the walk. null = nothing probeable
	 *  or the probe got no answer. */
	private async probeBenchedLeg(
		tier: string,
		req: UpstreamRequest,
		st: WalkState,
		dep?: Deployment,
	): Promise<Deployment | null> {
		const remainingMs = st.deadlineMs - this.now();
		if (remainingMs <= 0 || req.signal?.aborted) return null;
		const target =
			dep ??
			this.deps.pool
				.deployments(tier)
				.find(
					(d) => this.cooldowns.benched(d) && bridgeRequest(req, d) !== null,
				);
		if (target === undefined || !this.cooldowns.benched(target)) return null;
		const timeout = AbortSignal.timeout(Math.min(remainingMs, 3_000));
		const signal = req.signal
			? AbortSignal.any([req.signal, timeout])
			: timeout;
		const resp =
			(await this.deps.probe?.(target, signal)) ??
			(await fetch(`${target.url}/v1/models`, {
				method: "GET",
				signal,
			}).catch(() => null));
		if (resp === null) return null;
		this.cooldowns.success(target);
		return target;
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
			source: "cooldown",
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
		const deadlineMs =
			this.now() + (this.policy.first_byte_budget_s ?? 240) * 1000;
		if (req.sel)
			return this.walkSelected(req, {
				attempts: 0,
				status: 502,
				error: `no healthy upstream for ${req.group}`,
				deadlineMs,
			});
		const st: WalkState = {
			attempts: 0,
			status: 502,
			error: `no healthy upstream for ${req.group}`,
			deadlineMs,
		};
		const tiers = [req.group, ...(this.policy.fallbacks?.[req.group] ?? [])];
		for (const tier of tiers) {
			if (this.walkExpired(st)) break;
			if (FLASHX.test(tier)) {
				this.metrics?.refused(tier);
				continue;
			}
			const candidates = this.tierCandidates(tier, req);
			if (candidates.length === 0) {
				// W1077: probe-before-fail - a benched wall must not outlive the
				// upstream. Probe one benched leg; a live leg clears its bench
				// and rejoins this tier walk instead of stranding the request.
				const probed = await this.probeBenchedLeg(tier, req, st);
				if (probed !== null) {
					const r = await this.attemptTier(req, tier, [probed], st);
					if (r !== null) return r;
					continue;
				}
				this.rememberCooledRateLimit(tier, req, st);
				continue;
			}
			if (tier !== req.group) this.metrics?.fallback(tier);
			const r = await this.attemptTier(req, tier, candidates, st);
			if (r !== null) return r;
		}
		this.walkExpired(st);
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
		// W1080: name the real refusal — an all-unbridgeable selection is a
		// body the transform rejected, not an unhealthy upstream.
		if (ordered.length === 0 && sel.ordered.length > 0)
			st.error = `all ${String(sel.ordered.length)} selected row(s) unbridgeable — the transform rejected this request body`;
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
			if (this.walkExpired(st)) break;
			if (gate(row)) continue;
			if (this.cooldowns.rateLimitRemainingS(row.dep) !== null) {
				// W1077: probe-before-skip in the PRODUCTION selected path - a
				// rate-limit bench must not outlive the upstream. A live probe
				// clears the bench and the row rides now; a dead probe keeps the
				// remembered 429 envelope for the exhausted relay.
				if (
					(await this.probeBenchedLeg(row.group, req, st, row.dep)) !== null
				) {
					tried.add(row.candidate_id);
					const r = await this.attemptTier(req, row.group, [row.dep], st);
					if (r !== null) return r;
					continue;
				}
				this.rememberCooledRateLimit(row.group, req, st);
				continue;
			}
			tried.add(row.candidate_id);
			const r = await this.attemptTier(req, row.group, [row.dep], st);
			if (r !== null) return r;
		}
		if (sel.verb === "must" && sel.fit === sel.total && sel.total > 0) {
			// must-domain closed: no substitution beyond the hint (law 2)
			this.walkExpired(st);
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
			if (this.walkExpired(st)) break;
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
		this.walkExpired(st);
		return exhausted(st);
	}
}
