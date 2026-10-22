import { SseSniffer } from "../../buckle/src/sse.ts";
import { upstreamErrorDetail } from "../../buckle/src/error-detail.ts";

/** Backend admission may run inside its SSE generator, after HTTP 200.
 * Keep the caller's original deadline until usable output commits the stream.
 * Prelude bytes are retained once, bounded, then replayed without conversion. */
export async function primeLocalStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
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
	const abort = () => void reader.cancel(signal.reason).catch(() => {});
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) sniff.flush();
			else {
				bytes += next.value.byteLength;
				if (bytes > 65_536) throw new Error("local_stream_prelude_limit");
				chunks.push(next.value);
				sniff.push(next.value);
			}
			if (sniff.failed() || next.done) {
				await reader.cancel("local stream refused before output");
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
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
	}
	return {
		ok: true,
		body: new ReadableStream<Uint8Array>({
			async pull(controller) {
				const chunk = chunks.shift();
				if (chunk) return controller.enqueue(chunk);
				try {
					const next = await reader.read();
					if (next.done) controller.close();
					else controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
				}
			},
			cancel: (reason) => reader.cancel(reason),
		}),
	};
}
