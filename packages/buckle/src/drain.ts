// src/drain.ts — the ONE gateway drain state (W1156). A planned redeploy is
// positively known only when beginDrain ran from EXPLICIT deploy intent
// (the ops drain surface the deploy orchestrator calls; root ruling
// 2026-10-22: a bare SIGTERM is never proof — an unexpected shutdown keeps
// its real cause and gets no gateway_restarting terminal). Every other
// break — upstream timeout, network death, crash — keeps its real cause:
// the drain never labels a break it did not observe.
import type { Dialect } from "./upstreams.ts";

export interface DrainInfo {
	/** Why the process is draining — e.g. "deployment:SIGTERM". */
	reason: string;
	sinceMs: number;
	/** The bounded grace: the process force-exits at this wall clock. */
	deadlineMs: number;
}

let state: DrainInfo | null = null;
const listeners = new Set<(info: DrainInfo) => void>();

/** Mark the process positively draining and notify every in-flight stream
 *  listener once. Idempotent: the first reason wins, a second signal is a
 *  no-op (null return). */
export function beginDrain(reason: string, graceMs: number): DrainInfo | null {
	if (state !== null) return null;
	const now = Date.now();
	state = { reason, sinceMs: now, deadlineMs: now + graceMs };
	for (const fn of listeners) {
		try {
			fn(state);
		} catch {
			// a failing observer must never block the drain
		}
	}
	return state;
}

/** The active drain, or null = nothing positively known. */
export function drainInfo(): DrainInfo | null {
	return state;
}

/** Subscribe to the drain transition. A listener registered while the
 *  process is ALREADY draining fires immediately (a stream born mid-drain
 *  gets its terminal at once); the returned unsubscribe is then a no-op. */
export function onDrain(fn: (info: DrainInfo) => void): () => void {
	if (state !== null) {
		fn(state);
		return () => {};
	}
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Dialect-correct terminal SSE frame for a drain cut: anthropic rides
 *  `event: error` + the {type:"error"} envelope; openai rides a bare data
 *  frame with its own server_error taxonomy. code gateway_restarting, the
 *  request id, and retry guidance in the message. */
export function drainTerminalFrame(dialect: Dialect, rid: string): string {
	const message =
		"Gateway restarting for a planned deployment — reconnect and retry with backoff.";
	const error =
		dialect === "anthropic"
			? { type: "api_error", code: "gateway_restarting", message }
			: {
					type: "server_error",
					param: null,
					code: "gateway_restarting",
					message,
				};
	const envelope =
		dialect === "anthropic"
			? { type: "error", error, request_id: rid }
			: { error, request_id: rid };
	return dialect === "anthropic"
		? `event: error\ndata: ${JSON.stringify(envelope)}\n\n`
		: `data: ${JSON.stringify(envelope)}\n\n`;
}

/** Test seam: the drain is process-global module state. */
export function resetDrainForTest(): void {
	state = null;
	listeners.clear();
}
