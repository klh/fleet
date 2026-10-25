// src/router-attempt.ts — W1299 decomposition of router.ts (behavior identical):
// the single-attempt tier — readCapped/classifyFailure, provider-pool
// admission at the fetch seam, the outcome classifier tryOnce, and the
// W1078 admission helpers.
import {
	safeCorrelationId,
	safeProviderErrorToken,
	safeRefusalCode,
} from "../../telemetry/src/http-trace.ts";
import { safeTimeoutPhase } from "../../telemetry/src/transport-evidence.ts";
import {
	normalizeUpstreamError,
	routerErrorEnvelope,
} from "./adapters/errors.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { deriveAdapter } from "./adapters/types.ts";
import { bridgeRequest, bridgeResponse } from "./bridge.ts";
import { retryAfterS } from "./cooldown.ts";
import type { GatewayPolicy } from "./policy.ts";
import {
	assertProviderConcurrencyErrorCodes,
	bindProviderLease,
	ProviderAdmissionFull,
	type ProviderLease,
	type ProviderPoolPolicy,
	providerPressureOf,
} from "./provider-admission-core.ts";
import {
	type RouterHost,
	type TryOutcome,
	type UpstreamRequest,
	UpstreamError,
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
	// the body is now decoded text: length/encoding headers no longer apply
	const headers = new Headers(resp.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	// LiteLLM's api-base header may contain an operator URL. It belongs in
	// internal hop logs, never a client-facing error response.
	headers.delete("x-litellm-model-api-base");
	if (!requestId) headers.delete("x-request-id");
	if (!callId) headers.delete("x-litellm-call-id");
	if (requestId) headers.set("x-klh-upstream-request-id", requestId);
	if (callId) headers.set("x-litellm-call-id", callId);
	const replay = new Response(text, {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
	return { err, replay, requestId, callId };
}
	/** One upstream attempt, outcome classified for the walk. */
export async function tryOnce(
	host: RouterHost,
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
		const admission = poolId === null ? undefined : host.pools.get(poolId);
		let lease: ProviderLease | undefined;
		let queueWaitMs = 0;
		if (admission !== undefined && poolId !== null) {
			const queuedAt = host.now();
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
						host.policy.provider_pools?.[poolId],
						error instanceof ProviderAdmissionFull ? "full" : "expired",
						poolId,
						Math.max(0, Math.round(host.now() - queuedAt)),
					);
				}
				throw error;
			}
			queueWaitMs = Math.max(0, Math.round(host.now() - queuedAt));
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
			const raw = await host.fetchImpl(dep, wireReq, timeoutMs, stream);
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
			const { err, replay, requestId, callId } = await classifyFailure(
				dep,
				resp,
			);
			const ra = err.retryAfterS ?? retryAfterS(resp.headers, host.now);
			const pressure = providerPressureOf(
				{ concurrencyErrorCodes: providerConcurrencyCodesOf(dep, host.policy) },
				err.providerCode,
				err.message,
			);
			lease?.feedback?.(resp.status, ra, pressure);
			// W1257: bank the provider's own refusal words at every rate-limit
			// rung — a later bench-window hold answers with THE PROVIDER's
			// last-seen code/type/message as attributed context, never silence.
			if (err.kind === "rate_limited")
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
			if (!(resp.status === 429 && pressure === "concurrency")) {
				host.cooldowns.failure(
					dep,
					err.kind === "rate_limited" ? "rate_limited" : "other",
				);
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
		retryAfterS: Math.ceil(policy.intervalMs / 1000),
	};
}
export async function defaultFetchImpl(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
	stream?: { idleMs: number; totalMs: number },
): Promise<Response> {
	const { defaultFetch } = await import("./wire.ts");
	return defaultFetch(dep, req, timeoutMs, stream);
}
