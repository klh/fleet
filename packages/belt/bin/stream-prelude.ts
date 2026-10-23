import { SseSniffer } from "../../buckle/src/sse.ts";
import { upstreamErrorDetail } from "../../buckle/src/error-detail.ts";

/** Backend admission may run inside its SSE generator, after HTTP 200.
 * Keep the caller's original deadline until usable output commits the stream.
 * Prelude bytes are retained once, bounded, then replayed without conversion. */
export async function primeLocalStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onCleanup?: (cleanup: Promise<void>) => void,
): Promise<
	| { ok: true; body: ReadableStream<Uint8Array> }
	| { ok: false; status: number; error: string; retryAfterMs?: number }
> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let detail: ReturnType<typeof upstreamErrorDetail> | undefined;
	const sniff = new SseSniffer("openai", (frame) => {
		if (frame && typeof frame === "object" && "error" in frame)
			detail = upstreamErrorDetail(frame);
	});
	let cleanup: Promise<void> | undefined;
	const cancel = (reason: unknown) => {
		if (!cleanup) {
			cleanup = reader.cancel(reason).catch(() => {});
			onCleanup?.(cleanup);
		}
	};
	// W1117×primeLocalStream merge: the abort listener lives for the returned
	// stream's whole life — a caller abort AFTER priming must still error the
	// re-emitted body (during priming the fetch signal errors the raw body
	// natively; post-prime nothing else owns the cancel path).
	let abortReject: ((reason: unknown) => void) | undefined;
	const aborted: Promise<never> = new Promise((_, reject) => {
		abortReject = reject;
	});
	aborted.catch(() => {}); // a lone abort with no pending pull is not an error
	const abort = () => {
		abortReject?.(signal.reason);
		cancel(signal.reason);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			// abort-interruptible: Bun does not settle a reader.cancel() against
			// an already-parked read, so the race (not the cancel) is what wakes
			// the loop on a caller abort mid-prime.
			const next = await Promise.race([reader.read(), aborted]);
			signal.throwIfAborted();
			if (next.done) sniff.flush();
			else {
				bytes += next.value.byteLength;
				if (bytes > 65_536) throw new Error("local_stream_prelude_limit");
				chunks.push(next.value);
				sniff.push(next.value);
			}
			if (sniff.failed() || (next.done && !sniff.hasUsableOutput())) {
				cancel("local stream refused before output");
				return {
					ok: false,
					status:
						detail?.type === "overloaded_error"
							? 503
							: detail?.type === "invalid_request_error"
								? 400
								: 502,
					error: detail
						? `${detail.code ?? detail.type}: ${detail.message}`
						: (sniff.failureKind() ?? "empty_response"),
				};
			}
			if (sniff.hasUsableOutput()) break;
		}
	} catch (error) {
		cancel(error);
		throw error;
	}
	return {
		ok: true,
		body: new ReadableStream<Uint8Array>({
			async pull(controller) {
				const chunk = chunks.shift();
				if (chunk) return controller.enqueue(chunk);
				try {
					const next = await Promise.race([reader.read(), aborted]);
					if (next.done) controller.close();
					else controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
				}
			},
			cancel: (reason) => {
				signal.removeEventListener("abort", abort);
				return reader.cancel(reason);
			},
		}),
	};
}
