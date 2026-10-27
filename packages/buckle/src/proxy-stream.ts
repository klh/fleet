// src/proxy-stream.ts — SSE pass-through with the usage-only tee,
// W616.1 re-framer, W1106 stream receipts, W1156 drain terminals.

import { RouterError } from "./adapters/errors.ts";
import { affinityOn } from "./affinity.ts";
import { onDrain, writeDrainTerminal } from "./drain.ts";
import { endInflight } from "./gov/inflight.ts";
import { jsonResponse } from "./proxy-body.ts";
import { observe, type Ctx } from "./request-context.ts";
import { SseSniffer, sseReframer } from "./sse.ts";
import {
	blackHole,
	once,
	terminalOf,
	writeErrorEvent,
} from "./stream-terminal.ts";
import { record } from "./usage-record.ts";
import { SSE_HEADERS } from "./wire-stamp.ts";
import { safeFailureKind } from "@klh/telemetry/src/http-trace.ts";
import type { AppDeps } from "./app-deps.ts";
import type { ExecuteResult } from "./router.ts";

/** SSE pass-through with the usage-only tee: one branch flows to the client
 *  through the W616.1 sseReframer for anthropic clients (canonical frames,
 *  pings dropped, corrupt events quarantined — byte identity is amended:
 *  upstream framing defects must not reach lane clients), the other feeds
 *  the sniffer into a black hole. No re-route after first byte; an upstream
 *  death mid-stream appends a dialect error event and closes. */
export function streamResponse(
	deps: AppDeps,
	ctx: Ctx,
	result: Extract<ExecuteResult, { kind: "upstream" }>,
): Response | Promise<Response> {
	const upstream = result.response;
	if (!upstream.body) return jsonResponse(deps, ctx, result);
	const sniffer = new SseSniffer(ctx.dialect);
	const [sniffBranch, clientBranch] = upstream.body.tee();
	// W1106 (#55505): ONE cancel bus — a Request abort AND a downstream
	// reader.cancel (direct body cancel, no Request signal) both feed it;
	// both pipes ride its signal so either path tears the tee + upstream
	// down and the receipt banks downstream_cancel, never a misattributed
	// upstream error.
	let streamCancelled = false;
	const downstreamAbort = new AbortController();
	const cancelDownstream = (): void => {
		streamCancelled = true;
		downstreamAbort.abort();
	};
	// W1156: the transform controller is captured so the drain can enqueue a
	// terminal straight into the client queue — the pipe keeps its own
	// writer; never fight it with a second one.
	let drainCtl: TransformStreamDefaultController<Uint8Array> | null = null;
	const downstream = new TransformStream<Uint8Array, Uint8Array>({
		start: (c) => {
			drainCtl = c;
		},
		cancel: () => cancelDownstream(),
	});
	// W1156: a positively-known deployment drain ends this stream with a
	// dialect-correct gateway_restarting terminal. Delivered marks truth —
	// only a terminal the client stream actually accepted re-banks the
	// receipt (a drain racing an already-closed/cancelled stream keeps the
	// real cause). A stream born mid-drain fires immediately.
	// W1106: declared ahead of the W1156 drain listener — a stream born
	// mid-drain fires that listener synchronously and it reads these.
	let streamFailed = false;
	let streamFailureKind: string | null = null;
	let streamDrained = false;
	/** W1156.1: has this stream already observed its real cause — an in-band
	 *  error frame (the client holds it), a terminal pipe failure, or the
	 *  dialect's protocol terminal? */
	const causeObserved = (): boolean =>
		streamFailed || sniffer.failureKind() !== null || sniffer.completed();
	const offDrain = onDrain(() => {
		// W1156.1: a stream that ALREADY observed its real failure keeps it.
		// The drain never appends a second, misleading gateway_restarting
		// after the real error the client already holds — it only cuts the
		// stream through the abort bus, and the receipt keeps the first
		// cause. A cause-free live stream still gets the restart terminal.
		if (causeObserved()) {
			// Close the client side WITHOUT a new frame — the real error the
			// client already holds stays the last error on the wire. The same
			// terminate() teardown as the terminal path: the readable closes
			// (clean EOF), the writable errors, and the pipe rejection is
			// recognized via streamDrained — never downstream_cancel.
			try {
				drainCtl?.terminate();
			} catch {
				// already closing/closed — the stream was already ending
			}
			streamDrained = true; // the drain cut it — never downstream_cancel
			downstreamAbort.abort();
			return;
		}
		streamDrained = writeDrainTerminal(drainCtl, ctx.dialect, ctx.rid);
		// A delivered cut tears the tee + upstream now (bounded grace), but
		// through the abort bus's pipes only — streamCancelled stays false so
		// the receipt keeps the drained cause, never downstream_cancel.
		if (streamDrained) downstreamAbort.abort();
	});
	// W1106: body-free stream progress counters — terminal receipts answer
	// "who closed this stream" without ever logging payload.
	let bytesIn = 0;
	let chunksIn = 0;
	let lastChunkMs: number | null = null;
	// W1106 (#55419/#55420): EOF without the dialect's protocol terminal
	// (anthropic message_stop / openai [DONE] / response.completed) is a
	// TRUNCATED turn — never a completed success.
	let streamTruncated = false;
	// W1106 (#55446/#55461): typed in-band failure from the body (anthropic
	// event:error, openai response.failed/incomplete) — non-success even
	// when a terminal marker follows. null = none seen.
	let streamInBand: string | null = null;
	const t0 = ctx.t0;
	const progress = (chunk: Uint8Array): void => {
		chunksIn++;
		bytesIn += chunk.byteLength;
		lastChunkMs = Date.now() - t0;
	};
	const finish = once(() => {
		offDrain();
		sniffer.flush();
		// W1106 (#55419/#55420): the sniffer saw the full body — did the
		// dialect's protocol terminal arrive? A CLEAN EOF without it is a
		// truncated turn; a failed pipe keeps its failure kind as the cause
		// (the guard's deadline outranks the missing terminal), and an abort
		// never counts as truncation.
		// W1156: a drain terminal that cut a live turn short is the honest
		// non-success; a drain AFTER the dialect terminal is a cosmetic close
		// (the turn completed) and never re-labels the receipt.
		// W1156.1: gateway_restarting is the cause ONLY for a stream with no
		// earlier observed failure — an in-band error or pipe failure observed
		// before the drain outranks it in the durable receipt (first cause
		// wins, never overwritten by the later drain).
		const drainedCut =
			streamDrained &&
			!sniffer.completed() &&
			sniffer.failureKind() === null &&
			!streamFailed;
		streamTruncated =
			!sniffer.completed() && !streamCancelled && !streamFailed && !drainedCut;
		// W1106 (#55446/#55461): an IN-BAND failure (anthropic event:error /
		// openai response.failed|incomplete) is non-success even when a
		// terminal marker follows it.
		streamInBand = sniffer.failureKind();
		record(
			deps,
			ctx,
			sniffer.usage(),
			sniffer.cacheReported(),
			sniffer.cacheWriteReported(),
		);
		const selected = ctx.sel?.head.candidate_id;
		// W1106 (#55344): a downstream cancel is a DISTINCT non-success —
		// ok:0/decision errored, no affinity bind, no candidate success
		// credit; the receipt's terminal carries downstream_cancel.
		const decision =
			streamFailed ||
			streamCancelled ||
			streamTruncated ||
			drainedCut ||
			streamInBand !== null
				? "errored"
				: result.candidateId === selected
					? (ctx.sel?.decision ?? "errored")
					: "fallback";
		const success =
			!streamFailed &&
			!streamCancelled &&
			!streamTruncated &&
			!drainedCut &&
			streamInBand === null;
		const duration = Date.now() - ctx.t0;
		if (selected) deps.table.inflight(selected, -1);
		deps.table.recordOutcome(result.candidateId, duration, success);
		if (success && ctx.affKey && deps.affinity && affinityOn())
			deps.affinity.bind(ctx.affKey, result.candidateId);
		deps.ledger.auditOutcome(ctx.rid, {
			served: ctx.served,
			demand: ctx.demand,
			// Headers have already been sent; ok/error_code carry the later
			// stream failure without pretending the HTTP status was 502.
			status: 200,
			duration_ms: duration,
			ok: success,
			attempts: result.attempts,
			err: streamCancelled
				? "downstream_cancel"
				: drainedCut
					? "gateway_restarting"
					: success
						? null
						: streamInBand !== null
							? `stream_failed:${streamInBand}`
							: streamTruncated
								? "stream_truncated"
								: `stream_failed:${streamFailureKind ?? "unknown"}`,
			...(success
				? {}
				: {
						decision: "errored",
						error_code: streamCancelled
							? "downstream_cancel"
							: drainedCut
								? "gateway_restarting"
								: streamInBand !== null
									? "stream_failed"
									: streamTruncated
										? "stream_truncated"
										: "stream_failed",
					}),
			stream_receipt: {
				terminal: terminalOf(
					streamFailed,
					streamFailureKind,
					streamCancelled,
					drainedCut,
					streamTruncated,
					streamInBand,
				),
				bytes_in: bytesIn,
				chunks_in: chunksIn,
				last_chunk_ms: lastChunkMs,
			},
		});
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision, dialect: ctx.dialect });
		if (ctx.admitted)
			observe(deps, ctx, "lane.request.ended", {
				outcome: decision,
				status: 200,
				attempts: result.attempts,
			});
		endInflight(ctx.rid, 200, success, decision, null); // W1259: stream settle
		ctx.slot?.(); // W450: the drain settled — the upstream slot frees
	});
	sniffBranch
		.pipeTo(blackHole(sniffer, progress), { signal: downstreamAbort.signal })
		.catch(() => {
			// the sniff branch failing (or aborting) must not affect the client
		});
	// W1106: a quiet abort never rejects the pipe on its own (real-Bun
	// probe — Bun surfaces destination death only on the next failed
	// write), so the request signal drives BOTH pipes: pipeTo cancels its
	// source when the signal fires, which tears the tee branches down and
	// with them the upstream body (#55399: a client walk must free the
	// in-flight upstream slot, not leak it). The rejections land in the
	// handlers above — no branch.cancel() from outside a locked pipe (#55409:
	// that rejects a promise try/catch never sees).
	if (ctx.signal?.aborted === true) cancelDownstream();
	else
		ctx.signal?.addEventListener(
			"abort",
			() => {
				if (!streamCancelled) cancelDownstream();
			},
			{ once: true },
		);
	// W616.1: every SSE client gets the re-framer — canonical frames, pings
	// dropped, corrupt events quarantined (litellm's keepalive ping splices
	// mid-line under load; byte-identity forwarded the defect to the lane).
	// W1106 (#56010): the reframer also carries the empty-stream guard for
	// BOTH dialects — a success terminal without usable output reaches the
	// native client as the typed in-band error, matching the ledger.
	const sanitized = clientBranch.pipeThrough(
		sseReframer(
			(reason, preview) => {
				deps.sm
					.counter(
						"buckle_sse_reframe_dropped_total",
						"SSE events dropped by the re-framer (ping keepalives, quarantined upstream framing defects).",
					)
					.inc({ reason });
				console.warn(`buckle: sse reframe dropped (${reason}): ${preview}`);
			},
			ctx.dialect,
			(kind) => {
				streamFailed = true;
				streamFailureKind = kind;
			},
		),
	);
	sanitized
		.pipeTo(downstream.writable, {
			preventAbort: true,
			signal: downstreamAbort.signal,
		})
		.then(finish, (err: unknown) => {
			// W1156: the drain cut itself terminates the transform (Bun has no
			// TransformStreamDefaultController.close), so this rejection IS the
			// drain's own signature — the terminal is already queued ahead of
			// the close. Keep the drained cause; classifying it as an upstream
			// failure would mislabel the receipt and double-write an error.
			if (streamDrained) {
				finish();
				return;
			}
			// W1106: classify BEFORE the receipt lands. The request signal is
			// the honest cancel evidence (real-Bun probe: pipeTo rejects
			// LAZILY — on the next failed write, or carrying the upstream's
			// own error object — so rejection identity cannot separate a
			// client abort from an upstream death). A downstream reader.cancel
			// rides the same bus via the TransformStream cancel hook (#55505).
			if (downstreamAbort.signal.aborted) {
				streamCancelled = true;
			} else {
				streamFailed = true;
				// W1106: RouterError.kind is the typed taxonomy (wire guards
				// throw RouterError "timeout" at their deadlines); telemetry's
				// safeFailureKind is generic and would bucket it "error".
				streamFailureKind =
					err instanceof RouterError ? err.kind : safeFailureKind(err);
			}
			finish();
			if (!streamCancelled)
				writeErrorEvent(downstream.writable, ctx.dialect, err);
		})
		.catch(() => {
			// W1106: the error-event write failed = the client is gone; the
			// receipt already banked the upstream failure — terminal stands.
		});
	// W1106: the SSE contract is ours — a classified stream whose provider
	// omitted or mislabeled content-type must still carry the exact MIME the
	// server.ts per-request idle bypass keys on (scoped HERE, never in the
	// shared helper: jsonResponse/client-error pass through other bodies).
	const headers = SSE_HEADERS(upstream.headers);
	headers.set("content-type", "text/event-stream");
	return new Response(downstream.readable, {
		status: 200,
		headers,
	});
}
