// scripts/lib/bounded-tail.ts — W1205.2 shared bounded child-pipe capture.
// Drain-to-EOF keeps a piped child from deadlocking on a full pipe nobody
// reads; the bounded window bounds memory when a child floods diagnostics.
// Truncation is line-aligned: it drops through the first newline of the kept
// window (the whole window when no newline remains), so every kept line
// reaches per-line scrub rules whole — a secret is never revealed as a
// truncated suffix at the cut.

/** Window cap for captured child diagnostics (UTF-8 bytes). */
export const DIAGNOSTIC_TAIL_BYTES = 8 * 1024;

export interface BoundedTail {
	/** Decoded line-aligned tail text ("" when only a partial line survived). */
	text: string;
	/** Bytes dropped from the stream front, including the dropped partial line. */
	dropped: number;
}

/** Read a child pipe to EOF keeping only the last `maxBytes`. The window is
 *  line-aligned: truncation drops through the first newline of the kept
 *  window (the whole window when it holds no newline), so per-line
 *  sanitization never sees a truncated line. */
export const readBoundedTail = async (
	stream: ReadableStream<Uint8Array>,
	maxBytes = DIAGNOSTIC_TAIL_BYTES,
): Promise<BoundedTail> => {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	let kept = 0;
	let dropped = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			parts.push(value);
			kept += value.byteLength;
			while (kept > maxBytes && parts.length > 0) {
				const front = parts[0];
				if (front === undefined) break;
				const size = front.byteLength;
				if (kept - size >= maxBytes) {
					parts.shift();
					kept -= size;
					dropped += size;
					continue;
				}
				const cut = kept - maxBytes;
				dropped += cut;
				kept -= cut;
				parts[0] = front.subarray(cut);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const buf = Buffer.concat(parts);
	// line-align a truncated window: drop through the first newline
	if (dropped > 0 && kept > 0) {
		const nl = buf.indexOf(0x0a);
		if (nl === -1) return { text: "", dropped: dropped + kept };
		dropped += nl + 1;
		return { text: decodeTail(buf.subarray(nl + 1)), dropped };
	}
	return { text: decodeTail(buf), dropped };
};

const decodeTail = (buf: Uint8Array): string =>
	new TextDecoder("utf-8", { fatal: false }).decode(buf);
