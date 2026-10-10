// src/wire.ts — upstream request construction, now through the adapter
// registry (W134 §4.1): the deployment's family adapter builds the wire
// call (model alias patch + dialect patches + auth); responses are never
// re-serialized (see handlers.ts). The openai-compat adapter reproduces
// the pre-adapter body byte-for-byte (model patch + stream_options
// .include_usage injection; LiteLLM streaming_handler.py semantics, MIT) —
// the 37-test regression net pins the bytes.
import { resolveAdapter } from "./adapters/index.ts";
import { RouterError } from "./adapters/errors.ts";
import type { Deployment } from "./upstreams.ts";
import type { UpstreamRequest } from "./router.ts";
import { poolWarm } from "./pool-warm.ts";
import { childSpanOf, stripPrivateTrace } from "./trace.ts";

/** Streaming-body deadlines (W450): idle resets per chunk, total counts
 *  from fetch start. Absent → no stream-specific policy (the old shape). */
export interface StreamGuards {
	idleMs: number;
	totalMs: number;
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
	// W461 stage 1: one child traceparent per outbound attempt — same trace
	// id, fresh span id (retry ordinals distinct). Baggage never rides the
	// upstream leg (external-provider egress redaction): providers get the
	// traceparent only.
	wire.headers.traceparent = childSpanOf(req.trace?.traceparent);
	stripPrivateTrace(wire.headers);
	// W143 warm-rate gate: a cold origin (first dispatch since boot/pre-warm)
	// counts one pool_refill and marks warm — the connect cost is counted,
	// never silently mixed into the warm distribution.
	poolWarm.observe(wire.url);
	const t0 = Date.now();
	const ctrl = new AbortController();
	// TTFB guard — removed at headers so a streaming body can outlive it
	// (the old single AbortSignal.timeout killed healthy streams at the cap).
	const ttfb = AbortSignal.timeout(timeoutMs);
	const ttfbAbort = () => ctrl.abort(ttfb.reason);
	ttfb.addEventListener("abort", ttfbAbort);
	req.signal?.addEventListener("abort", () => ctrl.abort(req.signal?.reason), {
		once: true,
	});
	const resp = await fetch(wire.url, {
		method: "POST",
		headers: wire.headers,
		body: wire.body,
		signal: ctrl.signal,
	});
	ttfb.removeEventListener("abort", ttfbAbort);
	const elapsedMs = Date.now() - t0;
	if (stream) {
		return guardedBody(resp, {
			idleMs: stream.idleMs,
			totalMs: Math.max(stream.totalMs - elapsedMs, 1),
		});
	}
	// preserve the old whole-exchange cap on the remaining budget
	return guardedBody(resp, { totalMs: Math.max(timeoutMs - elapsedMs, 1) });
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
	g: { idleMs?: number; totalMs: number },
): Response {
	if (!resp.body) return resp;
	let idle: ReturnType<typeof setTimeout> | null = null;
	let done = false;
	let fail: ((e: unknown) => void) | null = null;
	const clear = () => {
		done = true;
		if (idle) clearTimeout(idle);
		clearTimeout(total);
	};
	const deadline = (what: string) => {
		if (done) return;
		clear();
		fail?.(
			new RouterError("timeout", 504, `upstream ${what} deadline exceeded`),
		);
	};
	const armIdle = () => {
		if (done || g.idleMs === undefined) return;
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => deadline("idle"), g.idleMs);
		idle.unref?.();
	};
	armIdle();
	const total = setTimeout(() => deadline("total"), g.totalMs);
	total.unref?.();
	return guardedPipe(resp, armIdle, clear, (f) => {
		fail = f;
	});
}

/** The guarded pipe: an identity transform that rearms the idle timer per
 *  arriving chunk and clears the timers at completion/cancellation, then
 *  returns a Response copy carrying the guarded stream (the original's body
 *  slot is single-use — see guardedBody). */
function guardedPipe(
	resp: Response,
	armIdle: () => void,
	clear: () => void,
	setFail: (f: (e: unknown) => void) => void,
): Response {
	const out = resp.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start: (c) => setFail((e: unknown) => c.error(e)),
			transform: (chunk, controller) => {
				armIdle();
				controller.enqueue(chunk);
			},
			flush: clear,
			cancel: clear,
		}),
	);
	return new Response(out, {
		status: resp.status,
		statusText: resp.statusText,
		headers: resp.headers,
	});
}
