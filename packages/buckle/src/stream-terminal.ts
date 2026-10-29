// src/stream-terminal.ts — stream finalization helpers extracted from
// handlers.ts (W1265 cap pay-down): the W1106 audit terminal classifier, the
// sniff-branch sink, the once-guard, mid-stream error events, and the
// scrubbed error-text face. Leaf module — imports only adapters/errors +
// sse types, never handlers.
import { RouterError, routerErrorEnvelope } from "./adapters/errors.ts";
import type { SseSniffer } from "./sse.ts";
import type { Dialect } from "./upstreams.ts";

export const enc = new TextEncoder();

/** /Users/<name> paths and key material never leave through an error. */
export function scrubText(text: string): string {
	return text.replace(/\/Users\/[^/\s'"]+/g, "~");
}

/** W1106: typed stream terminal for the audit receipt — who ended the
 *  stream, from the body-free evidence at this hop. EOF without the
 *  dialect's protocol terminal banks upstream_eof_truncated (#55420); an
 *  in-band failure body outranks a terminal marker that follows (#55446). */
export function terminalOf(
	failed: boolean,
	kind: string | null,
	cancelled: boolean,
	drained: boolean,
	truncated: boolean,
	inBand: string | null,
): string {
	if (cancelled) return "downstream_cancel";
	if (drained) return "gateway_restarting";
	if (inBand !== null) return `in_band_error:${inBand}`;
	if (!failed) return truncated ? "upstream_eof_truncated" : "upstream_eof";
	if (kind === "timeout") return "upstream_deadline";
	return `upstream_error:${kind ?? "unknown"}`;
}

/** Sink for the sniff branch: bytes in, usage extraction (+ the W1106
 *  progress counters), nothing out. */
export function blackHole(
	sniffer: SseSniffer,
	progress?: (chunk: Uint8Array) => void,
): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			progress?.(chunk);
			sniffer.push(chunk);
		},
	});
}

/** Run fn once; later callers are no-ops (stream finalization guard). */
export function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}

/** Mid-stream upstream death: append a dialect error event, close. */
export function writeErrorEvent(
	writable: WritableStream<Uint8Array>,
	dialect: Dialect,
	err: unknown,
): void {
	const message = scrubText(
		err instanceof Error ? err.message : "upstream stream failed",
	);
	const w = writable.getWriter();
	const envelope =
		err instanceof RouterError
			? routerErrorEnvelope(err, dialect, message)
			: { error: { message, type: "api_error", code: "stream_failed" } };
	const body =
		dialect === "anthropic"
			? `event: error\ndata: ${JSON.stringify({ type: "error", ...envelope })}\n\n`
			: `data: ${JSON.stringify(envelope)}\n\n`;
	void w
		.write(enc.encode(body))
		.then(() => w.close())
		.catch(() => {
			// client already gone — nothing to write to
		});
}
