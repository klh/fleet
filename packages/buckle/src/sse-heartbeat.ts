import { SSE_KEEPALIVE } from "./sse.ts";

export const SSE_QUIET_HEARTBEAT_MS = 25_000;
/** Trusted clock seam for deterministic transport tests; not an operator knob. */
export interface HeartbeatClock {
	now(): number;
	schedule(callback: () => void, delayMs: number): () => void;
}
const realClock: HeartbeatClock = {
	now: () => Date.now(),
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};
/** Final established SSE egress only. Comments never enter upstream guards,
 * sniffers, usage or model-progress counters. One queued comment and at most
 * one borrowed upstream chunk are retained under downstream backpressure.
 * Canonical frames are expected; a partial event is never split by a comment. */
export function withSseHeartbeats(
	source: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	clock: HeartbeatClock = realClock,
): ReadableStream<Uint8Array> {
	const reader = source.getReader(),
		heartbeat = new TextEncoder().encode(SSE_KEEPALIVE);
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let stopped = false,
		sourceFinished = false,
		reading = false,
		pending: Uint8Array | null = null;
	let clearTimer: (() => void) | undefined;
	let lastBytesAt = clock.now();
	let lineHasBytes = false,
		commentLine = false,
		eventOpen = false,
		previousCR = false;
	const observeBoundary = (chunk: Uint8Array) => {
		for (const byte of chunk) {
			if (byte === 10 && previousCR) {
				previousCR = false;
				continue;
			}
			if (byte === 10 || byte === 13) {
				if (!lineHasBytes) eventOpen = false;
				lineHasBytes = false;
				commentLine = false;
				previousCR = byte === 13;
			} else {
				previousCR = false;
				if (!lineHasBytes) commentLine = byte === 58;
				lineHasBytes = true;
				if (!commentLine) eventOpen = true;
			}
		}
	};
	const release = () => {
		try {
			reader.releaseLock();
		} catch {
			/* pending local read owns the lock until settlement */
		}
	};
	const stop = () => {
		stopped = true;
		pending = null;
		clearTimer?.();
		clearTimer = undefined;
		signal?.removeEventListener("abort", abort);
	};
	const cancelSource = (reason: unknown) => {
		void reader
			.cancel(reason)
			.catch(() => {})
			.finally(release);
	};
	const abort = () => {
		if (stopped) return;
		const reason =
			signal?.reason ?? new DOMException("Stream aborted", "AbortError");
		stop();
		controller.error(reason);
		cancelSource(reason);
	};
	const arm = () => {
		clearTimer?.();
		if (stopped || sourceFinished) return;
		clearTimer = clock.schedule(() => {
			clearTimer = undefined;
			if (stopped) return;
			pump();
			if (
				(controller.desiredSize ?? 0) > 0 &&
				!lineHasBytes &&
				!eventOpen &&
				clock.now() - lastBytesAt >= SSE_QUIET_HEARTBEAT_MS
			) {
				controller.enqueue(new Uint8Array(heartbeat));
				lastBytesAt = clock.now();
			}
			arm();
		}, SSE_QUIET_HEARTBEAT_MS);
	};
	const emit = (chunk: Uint8Array) => {
		if (!chunk.byteLength) return;
		observeBoundary(chunk);
		controller.enqueue(chunk);
		lastBytesAt = clock.now();
		arm();
	};
	const pump = () => {
		if (stopped || (controller.desiredSize ?? 0) <= 0) return;
		if (pending !== null) {
			const chunk = pending;
			pending = null;
			emit(chunk);
		}
		if (reading || (controller.desiredSize ?? 0) <= 0) return;
		reading = true;
		void reader.read().then(
			(part) => {
				reading = false;
				if (stopped) {
					release();
					return;
				}
				if (part.done) {
					stop();
					controller.close();
					release();
					return;
				}
				if ((controller.desiredSize ?? 0) > 0) emit(part.value);
				else pending = part.value;
				pump();
			},
			(error) => {
				reading = false;
				if (stopped) {
					release();
					return;
				}
				stop();
				controller.error(error);
				release();
			},
		);
	};
	void reader.closed.then(
		() => {
			sourceFinished = true;
			clearTimer?.();
			clearTimer = undefined;
		},
		(error) => {
			if (stopped) return;
			stop();
			controller.error(error);
			release();
		},
	);
	return new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
				if (signal?.aborted) abort();
				else {
					signal?.addEventListener("abort", abort, { once: true });
					arm();
				}
			},
			pull() {
				pump();
			},
			cancel(reason) {
				if (stopped) return;
				stop();
				cancelSource(reason);
			},
		},
		{ highWaterMark: 1 },
	);
}
