import { PREFER_HEADER } from "../../telemetry/src/prefer-header.ts";
import type { TransportEvidence } from "../../telemetry/src/transport-evidence.ts";
import { RouterError } from "./adapters/errors.ts";
// src/wire.ts — upstream request construction, now through the adapter
// registry (W134 §4.1): the deployment's family adapter builds the wire
// call (model alias patch + dialect patches + auth); responses are never
// re-serialized (see handlers.ts). The openai-compat adapter reproduces
// the pre-adapter body byte-for-byte (model patch + stream_options
// .include_usage injection; LiteLLM streaming_handler.py semantics, MIT) —
// the 37-test regression net pins the bytes.
import { resolveAdapter } from "./adapters/index.ts";
import { outboundBlockOf } from "./outbound-guard.ts";
import { poolWarm } from "./pool-warm.ts";
import type { UpstreamRequest } from "./router.ts";
import { childSpanOf, stripPrivateTrace } from "./trace.ts";
import type { Deployment } from "./upstreams.ts";
import {
	HOP_CONTRACT_HEADER,
	HopContractRefusal,
	childHopHeaderValue,
	isContractHop,
} from "./hop-deadline.ts";

/** A preference decision may cross Fleet-owned hops but not provider egress. */
export function mayRelayPrefer(dep: Deployment): boolean {
	if (dep.buckle) return true;
	try {
		return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
			new URL(dep.url).hostname,
		);
	} catch {
		return false;
	}
}

/** Streaming-body deadlines (W450): idle resets per chunk, total counts
 *  from fetch start. Absent → no stream-specific policy (the old shape). */
export interface StreamGuards {
	idleMs: number;
	totalMs: number;
}

/** A Buckle peer could not answer a short status request. This is distinct
 * from a responsive peer taking time to generate the first model token. */
export class HubConnectError extends Error {
	readonly layer = "connect";
	constructor() {
		super("Buckle peer connection unavailable");
	}
}

async function hubResponds(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const statusUrl = new URL("/status", url);
		const response = await fetch(statusUrl, {
			method: "GET",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

/** Default upstream transport: adapter-built wire call + fetch with
 *  timeout + caller-signal abort. `timeoutMs` bounds time-to-headers (and
 *  the WHOLE non-streaming exchange); streaming bodies get the W450 idle +
 *  total guards so a healthy long generation is never killed mid-flight. */
export async function defaultFetch(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
	stream?: StreamGuards,
): Promise<Response> {
	const adapter = resolveAdapter(dep);
	const wire = await adapter.buildCall(dep, req, req.body);
	// W1257.1 outbound guard: the adapter-built URL (post path_rewrite) is
	// checked BEFORE any network side effect — a blocked attempt throws
	// before fetch and before the buckle peer /status probe, so zero
	// upstream calls ever leave this process for the blocked endpoint.
	const blocked = outboundBlockOf(dep, req.path, wire.url);
	if (blocked) throw blocked;
	// W461 stage 1: one child traceparent per outbound attempt — same trace
	// id, fresh span id (retry ordinals distinct). Baggage never rides the
	// upstream leg (external-provider egress redaction): providers get the
	// traceparent only. W706: buckle-marked peers ARE the trust boundary —
	// the relay leg carries the hop marker baggage instead of the strip.
	wire.headers.traceparent = childSpanOf(req.trace?.traceparent);
	if (dep.buckle && req.relayBaggage) {
		wire.headers.baggage = req.relayBaggage;
	} else {
		stripPrivateTrace(wire.headers);
	}
	if (req.preference && mayRelayPrefer(dep))
		wire.headers[PREFER_HEADER] = req.preference;
	// W1118.1: the child hop contract rides every fleet leg (buckle peers +
	// the declared litellm engine) — budget counts down per attempt, the
	// path appends this hop's own rung, the deadline passes through
	// untouched. A contract that cannot encode refuses the leg: never a
	// contract-less bypass.
	if (req.hopContract && req.ownRung && isContractHop(dep)) {
		const value = childHopHeaderValue(req.hopContract);
		if (value === null) throw new HopContractRefusal(req.ownRung);
		wire.headers[HOP_CONTRACT_HEADER] = value;
	}
	// LiteLLM is an explicitly declared engine, never guessed from a port or
	// hostname. Buckle owns the outer retry ladder; pass its remaining
	// non-streaming attempt budget inward so abandoned calls do not continue
	// consuming provider capacity. For streaming, only an explicitly configured
	// LiteLLM first-chunk timeout is passed inward. Its stream timeout applies
	// to waits for chunks, so do not set a short wall-clock cap on generation.
	if (dep.adapter_config?.proxy_kind === "litellm") {
		wire.headers["x-litellm-num-retries"] = "0";
		if (!stream)
			wire.headers["x-litellm-timeout"] = String(
				Math.max(0.001, timeoutMs / 1000),
			);
		else {
			const configured = dep.adapter_config.litellm_stream_timeout_s;
			if (
				typeof configured === "number" &&
				Number.isFinite(configured) &&
				configured > 0
			)
				wire.headers["x-litellm-stream-timeout"] = String(
					Math.max(0.001, Math.min(configured, timeoutMs / 1000)),
				);
		}
	}
	// W143 warm-rate gate: a cold origin (first dispatch since boot/pre-warm)
	// counts one pool_refill and marks warm — the connect cost is counted,
	// never silently mixed into the warm distribution.
	if (
		dep.buckle &&
		!(await hubResponds(wire.url, Math.min(timeoutMs, 3_000), req.signal))
	) {
		if (req.signal?.aborted) throw req.signal.reason;
		throw new HubConnectError();
	}
	poolWarm.observe(wire.url);
	const t0 = Date.now();
	const evidence: TransportEvidence = {
		requestBodyBytes: Buffer.byteLength(wire.body),
		headersMs: null,
		firstBodyByteMs: null,
		timeoutBudgetMs: null,
		bodyBytes: 0,
		bodyChunks: 0,
		timeoutPhase: null,
		cancellation: null,
		providerCancellationAcknowledged: null,
	};
	const observe = () => req.transport?.observe(evidence);
	const ctrl = new AbortController();
	// TTFB guard — removed at headers so a streaming body can outlive it
	// (the old single AbortSignal.timeout killed healthy streams at the cap).
	const ttfb = AbortSignal.timeout(timeoutMs);
	const ttfbAbort = () => {
		if (ctrl.signal.aborted) return;
		evidence.timeoutPhase = "headers";
		evidence.timeoutBudgetMs = Math.ceil(timeoutMs);
		evidence.cancellation = "requested";
		observe();
		ctrl.abort(ttfb.reason);
	};
	ttfb.addEventListener("abort", ttfbAbort);
	const callerAbort = () => {
		if (ctrl.signal.aborted) return;
		evidence.cancellation = "requested";
		observe();
		ctrl.abort(req.signal?.reason);
	};
	req.signal?.addEventListener("abort", callerAbort, { once: true });
	if (req.signal?.aborted) callerAbort();
	let resp: Response;
	try {
		resp = await fetch(wire.url, {
			method: "POST",
			headers: wire.headers,
			body: wire.body,
			signal: ctrl.signal,
		});
	} catch (error) {
		if (ctrl.signal.aborted) evidence.cancellation = "local_settled";
		observe();
		req.signal?.removeEventListener("abort", callerAbort);
		throw error;
	} finally {
		ttfb.removeEventListener("abort", ttfbAbort);
	}
	evidence.headersMs = Date.now() - t0;
	observe();
	const bodyObservation = {
		evidence,
		observe,
		t0,
		cleanup: () => req.signal?.removeEventListener("abort", callerAbort),
	};
	ttfb.removeEventListener("abort", ttfbAbort);
	const elapsedMs = Date.now() - t0;
	if (stream) {
		return guardedBody(resp, {
			idleMs: stream.idleMs,
			totalMs: Math.max(stream.totalMs - elapsedMs, 1),
			...bodyObservation,
		});
	}
	// preserve the old whole-exchange cap on the remaining budget
	return guardedBody(resp, {
		totalMs: Math.max(timeoutMs - elapsedMs, 1),
		...bodyObservation,
	});
}

/** Wrap a response body with the W450 deadline guards: every arriving chunk
 *  resets the idle timer; the total timer fires regardless. A deadline
 *  errors the guarded stream (RouterError "timeout") — which cancels the
 *  upstream body and takes the tee branches down together. Timers clear
 *  when the body completes or is cancelled. Returns a Response carrying the
 *  guarded stream — Response methods read an internal body slot, so the
 *  original's body cannot be swapped in place (ERR_BODY_ALREADY_USED on
 *  arrayBuffer()). */
function guardedBody(
	resp: Response,
	g: {
		idleMs?: number;
		totalMs: number;
		evidence: TransportEvidence;
		observe: () => void;
		t0: number;
		cleanup: () => void;
	},
): Response {
	if (!resp.body) {
		g.cleanup();
		return resp;
	}
	const reader = resp.body.getReader();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let total: ReturnType<typeof setTimeout> | undefined;
	let done = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const clear = () => {
		done = true;
		clearTimeout(idle);
		clearTimeout(total);
		g.cleanup();
	};
	const cancel = (reason: unknown) => {
		g.evidence.cancellation = "requested";
		g.observe();
		// Settlement proves only the local reader cancellation, never provider cleanup.
		return reader.cancel(reason).then(
			() => {
				g.evidence.cancellation = "local_settled";
				g.observe();
			},
			() => {
				g.evidence.cancellation = "local_failed";
				g.observe();
			},
		);
	};
	const deadline = (phase: TransportEvidence["timeoutPhase"]) => {
		if (done) return;
		g.evidence.timeoutPhase = phase;
		g.evidence.timeoutBudgetMs = Math.ceil(
			phase === "stream_idle" ? (g.idleMs ?? g.totalMs) : g.totalMs,
		);
		clear();
		const error = new RouterError(
			"timeout",
			504,
			`upstream ${phase} deadline exceeded`,
		);
		controller.error(error);
		void cancel(error);
	};
	const armIdle = () => {
		if (g.idleMs === undefined || done) return;
		clearTimeout(idle);
		idle = setTimeout(() => deadline("stream_idle"), g.idleMs);
		idle.unref?.();
	};
	const out = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			armIdle();
			total = setTimeout(
				() =>
					deadline(g.idleMs === undefined ? "exchange_total" : "stream_total"),
				g.totalMs,
			);
			total.unref?.();
		},
		async pull(c) {
			try {
				const part = await reader.read();
				if (done) return;
				if (part.done) {
					clear();
					g.observe();
					c.close();
					return;
				}
				g.evidence.bodyBytes = Math.min(
					Number.MAX_SAFE_INTEGER,
					g.evidence.bodyBytes + part.value.byteLength,
				);
				g.evidence.bodyChunks = Math.min(
					Number.MAX_SAFE_INTEGER,
					g.evidence.bodyChunks + 1,
				);
				if (g.evidence.firstBodyByteMs === null && part.value.byteLength > 0) {
					g.evidence.firstBodyByteMs = Date.now() - g.t0;
					g.observe();
				}
				armIdle();
				c.enqueue(part.value);
			} catch (error) {
				if (done) return;
				clear();
				if (g.evidence.cancellation === "requested")
					g.evidence.cancellation = "local_settled";
				g.observe();
				c.error(error);
			}
		},
		cancel(reason) {
			clear();
			return cancel(reason);
		},
	});
	// fetch already decoded the body: forwarding the upstream's encoding or
	// length makes the next hop gunzip plain bytes (ZlibError spoke→hub)
	const headers = new Headers(resp.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(out, {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
}
