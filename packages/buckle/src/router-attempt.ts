// src/router-attempt.ts — W1299 decomposition of router.ts (behavior identical):
// the single-attempt tier — readCapped/classifyFailure, provider-pool
// admission at the fetch seam, the outcome classifier tryOnce, and the
// W1078 admission helpers.
import {
	safeCorrelationId,
	safeProviderErrorToken,
	safeRefusalCode,
	traceIdOf,
} from "@klh/telemetry/src/http-trace.ts";
import { safeTimeoutPhase } from "@klh/telemetry/src/transport-evidence.ts";
import {
	normalizeUpstreamError,
	RouterError,
	routerErrorEnvelope,
} from "./adapters/errors.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { deriveAdapter } from "./adapters/types.ts";
import { bridgeRequest, bridgeResponse } from "./bridge.ts";
import { retryAfterS } from "./cooldown.ts";
import { clampRetryAfter } from "./http-kit.ts";
import { peerErrorTrace } from "./error-trace.ts";
import type { GatewayPolicy } from "./policy.ts";
import {
	RESILIENCE_DEFAULTS,
	type ResilienceConfig,
} from "./resilience-config.ts";
import {
	assertProviderConcurrencyErrorCodes,
	bindProviderLease,
	ProviderAdmissionFull,
	type ProviderLease,
	type ProviderPoolPolicy,
	providerPressureOf,
	refusalShrinks,
} from "./provider-admission-core.ts";
import {
	type RouterHost,
	type TryOutcome,
	UpstreamError,
	type UpstreamRequest,
} from "./router-types.ts";
import type { Deployment } from "./upstreams.ts";
import { HubConnectError } from "./wire.ts";

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
async function classifyFailure(
	dep: Deployment,
	resp: Response,
	expectedTraceId: string,
) {
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
	const record =
		wire && typeof wire === "object" ? (wire as Record<string, unknown>) : null;
	const detail =
		record?.error && typeof record.error === "object"
			? (record.error as Record<string, unknown>)
			: null;
	const requestId = safeCorrelationId(
		resp.headers.get("x-request-id") ??
			detail?.request_id ??
			record?.request_id,
	);
	const callId = safeCorrelationId(resp.headers.get("x-litellm-call-id"));
	const peerTrace = peerErrorTrace(
		resp,
		wire,
		expectedTraceId,
		dep.buckle === true,
	);
	// the body is now decoded text: length/encoding headers no longer apply
	const headers = new Headers(resp.headers);
	// A provider may send Fleet-looking headers. Only a configured Buckle
	// peer with a matching, validated body may contribute a previous hop.
	for (const header of [
		"x-klh-peer-error-trace",
		"x-klh-service",
		"x-klh-trace-id",
		"x-klh-error-origin",
	])
		headers.delete(header);
	headers.delete("content-length");
	headers.delete("content-encoding");
	// LiteLLM's api-base header may contain an operator URL. It belongs in
	// internal hop logs, never a client-facing error response.
	headers.delete("x-litellm-model-api-base");
	if (!requestId) headers.delete("x-request-id");
	if (!callId) headers.delete("x-litellm-call-id");
	if (requestId) headers.set("x-klh-upstream-request-id", requestId);
	if (callId) headers.set("x-litellm-call-id", callId);
	if (peerTrace) headers.set("x-klh-peer-error-trace", peerTrace);
	const replay = new Response(text, {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
	return { err, replay, requestId, callId, peerTrace };
}
/** One upstream attempt, outcome classified for the walk. */
export async function tryOnce(
	host: RouterHost,
	req: UpstreamRequest,
	dep: Deployment,
	timeoutMs: number,
	stream?: { idleMs: number; totalMs: number },
	walkRemainingMs = timeoutMs,
	connectMs?: number,
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
	// Shared cold mark (anti-stampede): a cold account is never knocked; a
	// half-open one admits exactly ONE probe. A lost race answers locally,
	// instantly — no fetch, no queue, no sleep.
	if (!host.cooldowns.cold.claimProbe(dep))
		return coldRefusal(host, dep, poolId, null);
	const admission = poolId === null ? undefined : host.pools.get(poolId);
	let lease: ProviderLease | undefined;
	let queueWaitMs = 0;
	if (admission !== undefined && poolId !== null) {
		const queuedAt = host.now();
		try {
			// Admission may wait inside the remaining walk, clamped by the
			// resilience max_queue_wait_ms — a SHORT bounded queue, never the
			// multi-minute hold a pool policy may declare. The network timeout
			// is an upper bound, never a second budget beyond the walk.
			lease = await admission.acquire(
				req.signal,
				Math.max(
					1,
					Math.min(walkRemainingMs - 1, resilienceOf(host).max_queue_wait_ms),
				),
			);
		} catch (error) {
			if (req.signal?.aborted) throw error;
			const expired = error instanceof Error && error.name === "TimeoutError";
			if (error instanceof ProviderAdmissionFull || expired) {
				return admissionRefusal(
					dep,
					host.policy.provider_pools?.[poolId],
					error instanceof ProviderAdmissionFull ? "full" : "expired",
					poolId,
					Math.max(0, Math.round(host.now() - queuedAt)),
					error instanceof ProviderAdmissionFull ? error.retryAfterMs : null,
				);
			}
			throw error;
		}
		queueWaitMs = Math.max(0, Math.round(host.now() - queuedAt));
		// a queued caller re-checks the mark at grant: a sibling's refusal
		// while it waited colds the account — still no knock (N → 1)
		if (host.cooldowns.cold.state(dep) === "cold") {
			lease.release();
			return coldRefusal(host, dep, poolId, queueWaitMs);
		}
		const remainingMs = walkRemainingMs - queueWaitMs;
		if (remainingMs <= 0) {
			lease.release();
			return admissionRefusal(
				dep,
				host.policy.provider_pools?.[poolId],
				"expired",
				poolId,
				queueWaitMs,
			);
		}
		timeoutMs = Math.min(timeoutMs, remainingMs);
	}
	try {
		const raw = await host.fetchImpl(
			dep,
			wireReq,
			timeoutMs,
			stream,
			connectMs,
		);
		const resp = lease === undefined ? raw : bindProviderLease(raw, lease);
		if (resp.ok) {
			host.cooldowns.success(dep);
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
		const { err, replay, requestId, callId, peerTrace } = await classifyFailure(
			dep,
			resp,
			traceIdOf(req.trace?.traceparent ?? null) ?? "",
		);
		const ra = err.retryAfterS ?? retryAfterS(resp.headers, host.now);
		const pressure = providerPressureOf(
			{ concurrencyErrorCodes: providerConcurrencyCodesOf(dep, host.policy) },
			err.providerCode,
			err.message,
		);
		lease?.feedback?.(
			resp.status,
			ra,
			pressure,
			undefined,
			refusalShrinks(err.providerCode),
		);
		// One refusal colds the ACCOUNT for every caller (short for rate
		// pressure, long for a declared quota wall) — account occupancy
		// (explicit concurrency evidence) stays the pool's AIMD business.
		// A peer gateway's quota verdict rides x-should-retry: false.
		const quotaWall =
			isQuotaWall(err.providerCode, resilienceOf(host)) ||
			(resp.status === 429 && resp.headers.get("x-should-retry") === "false");
		const limited = quotaWall || err.kind === "rate_limited";
		// a peer gateway answering from ITS cold mark speaks problem+json —
		// relay that local story as-is, never re-wrap it as a provider envelope
		const peerLocal =
			limited &&
			(replay.headers.get("content-type") ?? "").includes("problem+json");
		if (quotaWall || (err.kind === "rate_limited" && pressure !== "concurrency"))
			host.cooldowns.cold.cool(dep, { retryAfterS: ra, quota: quotaWall });
		const shown = limited ? asRateLimited(err, ra) : err;
		// W1257: bank the provider's own refusal words at every rate-limit
		// rung — a later bench-window hold answers with THE PROVIDER's
		// last-seen code/type/message as attributed context, never silence.
		if (limited)
			host.cooldowns.noteRateLimitDetail(dep, {
				code: err.providerCode,
				type: err.providerType,
				message: err.message,
				retryAfterS: ra,
			});
		const base = {
			transportTimeoutPhase: dep.buckle
				? safeTimeoutPhase(resp.headers.get("x-klh-transport-timeout-phase"))
				: null,
			providerPool: poolId,
			queueWaitMs: lease ? queueWaitMs : null,
			providerErrorCode: safeProviderErrorToken(err.providerCode),
			providerErrorType: safeProviderErrorToken(err.providerType),
			ok: false as const,
			response: limited
				? new Response(
						peerLocal
							? replay.body
							: JSON.stringify(routerErrorEnvelope(shown, req.dialect)),
						{
						status: 429,
						headers: limitedHeaders(
							replay.headers,
							// An upstream-answered refusal relays the PROVIDER's
							// Retry-After, clamped at emission (W1303.2: a quota
							// wall never sleeps a client for weeks); callers the
							// shared cold mark answers locally get its remainder.
							ra === null ? null : (retryAfterS(replay.headers) ?? ra),
							quotaWall,
							peerLocal,
						),
					},
				)
				: replay,
			status: limited ? 429 : resp.status,
			retryAfterS: ra,
			kind: shown.kind,
			contextWindow: err.contextWindow,
			refusalSource: "upstream" as const,
			requestId,
			callId,
			peerTrace,
			upstreamRefusalCode: safeRefusalCode(resp.headers.get("x-klh-refusal")),
		};
		// W1118.1: a peer's hop-contract refusal is a chain verdict — the
		// contract binds every fleet leg, so the walk must not detour to
		// another rung (an A→B→A cycle must not serve itself via a
		// provider failover). The specific code rides x-belt-error, stamped
		// by the peer's deny(); the refusing peer is healthy — no bench.
		const peerCode = safeRefusalCode(resp.headers.get("x-belt-error"));
		if (peerCode?.startsWith("hop_contract_")) {
			return {
				...base,
				error: `upstream ${dep.url} refused the hop contract (${peerCode})`,
				clientFault: false,
				exhaustTier: true,
				hopRefusal: peerCode,
				refusalSource: "upstream",
			};
		}
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
			!limited &&
			err.kind === "bad_request" &&
			resp.status < 500 &&
			resp.status !== 404;
		if (clientFault) {
			// W987: a client-fault rung is THIS deployment refusing the ride
			// (its model/feature set), not the request being unrouteable —
			// bench it and let the walk continue; hard-abort is reserved for
			// req-level faults, which ingress admission owns.
			host.cooldowns.failure(dep);
			host.metrics?.cooldown(`${dep.group}|${dep.url}`);
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
		// Rate/quota refusals already colded the account above (shared mark,
		// not the consecutive-failure ejection).
		if (limited) {
			if (pressure !== "concurrency" || quotaWall)
				host.metrics?.cooldown(`${dep.group}|${dep.url}`);
		} else {
			host.cooldowns.failure(dep, "other");
			host.metrics?.cooldown(`${dep.group}|${dep.url}`);
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
			exhaustTier: shown.kind !== "auth" && !shown.retryable,
		};
	} catch (e) {
		// W1078: no Response exists to hold the lease — release before any
		// classification/wrap so a failed fetch never leaks its slot.
		lease?.release();
		// a cancelled half-open probe never wedges the account
		host.cooldowns.cold.releaseProbe(dep);
		if (req.signal?.aborted) throw e;
		const connectFailure = e instanceof HubConnectError;
		const timedOut =
			(e instanceof Error && e.name === "TimeoutError") ||
			(e instanceof UpstreamError && e.timedOut);
		if (connectFailure) host.cooldowns.eject(dep);
		else host.cooldowns.failure(dep);
		host.metrics?.cooldown(`${dep.group}|${dep.url}`);
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
/** W1078: the explicit account binding on a deployment — a bounded pool id
 *  into gateway.provider_pools, operator config, never derived from host,
 *  model name or secret bytes (admission-core notes). */
export function providerPoolIdOf(dep: Deployment): string | null {
	const cfg = dep.adapter_config?.provider_pool;
	if (typeof cfg !== "string") return null;
	return /^[\w.-]{1,64}$/.test(cfg) ? cfg : null;
}
export function providerConcurrencyCodesOf(
	dep: Deployment,
	policy: GatewayPolicy,
): string[] | undefined {
	const explicit = dep.adapter_config?.provider_concurrency_error_codes;
	const pool = providerPoolIdOf(dep);
	const inherited =
		pool === null
			? undefined
			: policy.provider_pools?.[pool]?.concurrencyErrorCodes;
	if (explicit === undefined) return inherited;
	assertProviderConcurrencyErrorCodes(explicit);
	if (
		inherited &&
		(explicit.length !== inherited.length ||
			explicit.some((code) => !inherited.includes(code)))
	)
		throw new Error(
			"Deployment concurrency error codes conflict with its provider pool policy",
		);
	return explicit;
}
/** W1078 local admission refusal: a LOCAL queue decision, never an upstream
 *  verdict — no bench, no provider cooldown, no fabricated 429. The 503
 *  carries the pool's window-derived Retry-After floor (config, not a
 *  provider claim). */
function admissionRefusal(
	dep: Deployment,
	policy: ProviderPoolPolicy,
	cause: "full" | "expired",
	providerPool: string,
	queueWaitMs: number,
	pausedForMs: number | null = null,
): TryOutcome {
	return {
		ok: false,
		localAdmission: true,
		providerPool,
		queueWaitMs,
		status: 503,
		error:
			cause === "full"
				? `provider account pool for ${dep.url} is saturated — admission refused locally (W1078)`
				: `provider account pool wait expired for ${dep.url} — admission timed out locally (W1078)`,
		// A pool paused past the caller's wait answers with the honest pause
		// remainder (clamped at emission), else the window-derived floor.
		retryAfterS: Math.max(
			Math.ceil(policy.intervalMs / 1000),
			pausedForMs === null ? 0 : Math.ceil(pausedForMs / 1000),
		),
	};
}

/** The shared cold mark answering locally — no fetch, no sleep. */
function coldRefusal(
	host: RouterHost,
	dep: Deployment,
	providerPool: string | null,
	queueWaitMs: number | null,
): TryOutcome {
	return {
		ok: false,
		localAdmission: true,
		providerPool,
		queueWaitMs,
		status: 503,
		error: `upstream ${dep.url} is cooling down (shared cold mark) — answered locally, no upstream knock`,
		retryAfterS: host.cooldowns.cold.remainingS(dep) ?? 1,
	};
}

/** A quota wall surfaces as the rate-limit kind (one client contract:
 *  429 + Retry-After); its provider code/type/words ride unchanged. */
function asRateLimited(err: RouterError, ra: number | null): RouterError {
	if (err.kind === "rate_limited") return err;
	return new RouterError(
		"rate_limited",
		429,
		err.message,
		err.family,
		ra,
		false,
		err.providerCode,
		err.providerType,
		err.traceId,
	);
}

/** Client headers for a limited refusal: provider headers minus its raw
 *  retry-after, the clamped honest one, and — on a quota wall only —
 *  x-should-retry: false (the Anthropic SDK honours it: the client fails
 *  fast instead of burning its retry ladder into a wall). */
function limitedHeaders(
	provider: Headers,
	retryAfterS: number | null,
	quotaWall: boolean,
	keepBody = false,
): Record<string, string> {
	return {
		...Object.fromEntries(
			[...provider].filter(
				([k]) => k !== "retry-after" && k !== "content-length",
			),
		),
		"content-type": keepBody
			? (provider.get("content-type") ?? "application/problem+json")
			: "application/json",
		...(retryAfterS === null
			? {}
			: { "retry-after": String(clampRetryAfter(retryAfterS)) }),
		...(quotaWall ? { "x-should-retry": "false" } : {}),
	};
}

/** The resolved resilience block (absent policy block = defaults). */
export const resilienceOf = (host: RouterHost): ResilienceConfig =>
	host.policy.resilience ?? RESILIENCE_DEFAULTS;

/** Balance/plan exhaustion — a declared quota-wall code (config). Rate
 *  pressure (1302/1305, plain 429) is NEVER a wall. */
export const isQuotaWall = (
	code: string | number | null,
	cfg: ResilienceConfig,
): boolean => code !== null && cfg.quota_wall_codes.includes(String(code));
export async function defaultFetchImpl(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
	stream?: { idleMs: number; totalMs: number },
	connectMs?: number,
): Promise<Response> {
	const { defaultFetch } = await import("./wire.ts");
	return defaultFetch(dep, req, timeoutMs, stream, connectMs);
}
