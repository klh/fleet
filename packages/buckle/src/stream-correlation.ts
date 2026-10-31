// src/stream-correlation.ts — W2260: provider-neutral hop/trace
// correlation for streaming responses. Every bounded field here is
// transport metadata only — never prompt or key content:
//   upstream_request_id — the provider/peer's x-request-id echo
//   litellm_call_id     — LiteLLM's per-call id (x-litellm-call-id)
//   activity            — semantic | ping_only | none (see below)
//
// The three-way activity split answers the W2260 incident question
// ("HTTP 200, 188 bytes, 60s idle, provider-side close?") without payload:
//   semantic  — at least one NON-keepalive SSE data frame arrived
//   ping_only — frames arrived but ALL were transport keepalives
//   none      — not even keepalives (a true no-byte stall)
import { safeCorrelationId } from "@klh/telemetry/src/http-trace.ts";

export type StreamActivity = "semantic" | "ping_only" | "none";

/** Bounded correlation ids carried by a streamed upstream response. */
export interface HopCorrelation {
	upstreamRequestId: string | null;
	litellmCallId: string | null;
}

/** W1106: how a streaming body actually ended — typed terminal, upstream
 *  progress counters, last-chunk timestamp (ms from t0). Body-free: no
 *  prompt or completion content ever rides this. (W2260: moved here from
 *  ledger.ts and extended with activity + hop correlation.) */
export interface StreamReceipt {
	/** upstream_eof = clean provider close; upstream_error:<kind> = the
	 *  provider died mid-stream; downstream_cancel = the client hung up;
	 *  upstream_idle/total_deadline = the wire guards fired. */
	terminal: string;
	/** bytes/chunks seen FROM the upstream (activity evidence). */
	bytes_in: number;
	chunks_in: number;
	/** ms from request start to the last upstream chunk (null = none). */
	last_chunk_ms: number | null;
	/** W2260: semantic = non-keepalive frames arrived; ping_only = only
	 *  transport keepalives; none = a true no-byte stall. null = unknown
	 *  (rows banked before W2260). */
	activity?: "semantic" | "ping_only" | "none" | null;
	/** W2260: a failed/truncated stream with zero client-visible semantic
	 *  output could be retried without duplicating output. false on a
	 *  completed stream (n/a) and on pre-W2260 rows (absent). */
	retry_eligible?: boolean | null;
	/** W2260: the upstream's own correlation ids (bounded, safe-parsed;
	 *  null = the provider/peer sent none). */
	upstream_request_id?: string | null;
	litellm_call_id?: string | null;
}

/** Extract the upstream's own correlation ids from a streamed response's
 *  headers (the failure path already classifies these in
 *  router-attempt.ts; the SUCCESS-stream path had none). Junk never
 *  passes safeCorrelationId — null = honest unknown. */
export function hopCorrelationOf(headers: Headers): HopCorrelation {
	return {
		upstreamRequestId:
			safeCorrelationId(
				headers.get("x-klh-upstream-request-id") ??
					headers.get("x-request-id"),
			) ?? null,
		litellmCallId: safeCorrelationId(headers.get("x-litellm-call-id")) ?? null,
	};
}

/** Classify what a finished stream actually carried. `frames` counts
 *  non-keepalive data frames (SseSniffer.framesSeen), `pings` counts
 *  reframer ping drops. */
export function streamActivityOf(frames: number, pings: number): StreamActivity {
	return frames > 0 ? "semantic" : pings > 0 ? "ping_only" : "none";
}
