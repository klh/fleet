// src/router-outcome.ts — the classified outcome of one upstream attempt:
// failure normalization off a non-ok body, network-death wrapping, the
// W1078 local admission refusal, walk exhaustion, and the provider-pool
// id derivation. Extracted from router.ts (W1238.6.2); the Router class
// keeps the ladder walk.
import { safeCorrelationId } from "../../telemetry/src/http-trace.ts";
import { normalizeUpstreamError } from "./adapters/errors.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { deriveAdapter } from "./adapters/types.ts";
import type { GatewayPolicy } from "./policy.ts";
import {
	assertProviderConcurrencyErrorCodes,
	type ProviderPoolPolicy,
} from "./provider-admission-core.ts";
import type { ExecuteResult, TryOutcome, WalkState } from "./router-types.ts";
import type { Deployment, UpstreamRequest } from "./upstreams.ts";

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
export async function classifyFailure(dep: Deployment, resp: Response) {
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

/** Thrown when an upstream is unreachable (network/timeout); the walk
 *  catches it and keeps going (ladder), rethrows on caller abort. */
export class UpstreamError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly layer: "connect" | "upstream" = "upstream",
		public readonly timedOut = false,
		public readonly providerPool: string | null = null,
		public readonly queueWaitMs: number | null = null,
	) {
		super(message);
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
export function admissionRefusal(
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
/** End of a walk with nothing delivered: an all-rungs context-window
 *  overflow answers the upstream's 4xx; anything else is exhausted. */
export function exhausted(st: WalkState): ExecuteResult {
	if (st.rateLimit)
		return {
			kind: "client-error",
			response: st.rateLimit.response,
			tier: st.rateLimit.tier,
			attempts: st.attempts,
			refusalSource: st.rateLimit.source,
			failureKind: "rate_limited",
		};
	if (st.ctxWindow)
		return {
			kind: "client-error",
			response: st.ctxWindow,
			tier: "",
			attempts: st.attempts,
			refusalSource: "upstream",
			failureKind: "bad_request",
		};
	return {
		kind: "exhausted",
		status: st.status,
		error: st.error,
		attempts: st.attempts,
		lastFailure: st.lastFailure,
		...(st.lastFailure?.status === 503 &&
		st.lastFailure.retryAfterS !== undefined
			? { retryAfterS: st.lastFailure.retryAfterS }
			: {}),
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
