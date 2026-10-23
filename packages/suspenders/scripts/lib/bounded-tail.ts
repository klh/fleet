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

/** Owned bounded window of retained stream bytes (W1205.2.1.1): every
 *  retained chunk is copied into owned exact-size storage — a below-cap view
 *  must not pin its oversized source ArrayBuffer; zero-byte reads are skipped
 *  so metadata cannot accumulate while a pipe trickles toward EOF. */
export class BoundedTailWindow {
	private readonly parts: Uint8Array[] = [];
	private kept = 0;
	dropped = 0;

	constructor(private readonly maxBytes: number) {}

	push(chunk: Uint8Array): void {
		// a zero-byte read carries no bytes — don't bank its metadata
		if (chunk.byteLength === 0) return;
		// review 59258: a below-cap chunk may still be a 1-byte view into a
		// 16 MiB source — retained as-is it pins the whole source ArrayBuffer.
		this.parts.push(ownedCopy(chunk, 0));
		this.kept += chunk.byteLength;
		while (this.kept > this.maxBytes && this.parts.length > 0) {
			const front = this.parts[0];
			if (front === undefined) break;
			const size = front.byteLength;
			if (this.kept - size >= this.maxBytes) {
				this.parts.shift();
				this.kept -= size;
				this.dropped += size;
				continue;
			}
			const cut = this.kept - this.maxBytes;
			this.dropped += cut;
			this.kept -= cut;
			this.parts[0] = ownedCopy(front, cut);
			break;
		}
	}

	/** Diagnostic view: the retained pieces — owned copies after any cut. */
	pieces(): readonly Uint8Array[] {
		return this.parts;
	}

	keptBytes(): number {
		return this.kept;
	}

	/** Line-aligned decode per the W1205.2 truncation contract. */
	finish(): BoundedTail {
		const buf = Buffer.concat(this.parts);
		if (this.dropped > 0 && buf.byteLength > 0) {
			const nl = buf.indexOf(0x0a);
			if (nl === -1) {
				return { text: "", dropped: this.dropped + buf.byteLength };
			}
			return {
				text: decodeTail(buf.subarray(nl + 1)),
				dropped: this.dropped + nl + 1,
			};
		}
		return { text: decodeTail(buf), dropped: this.dropped };
	}
}

/** Fresh-storage copy — Uint8Array#slice/subarray would stay a view on node
 *  Buffer inputs, silently retaining the source ArrayBuffer. */
const ownedCopy = (src: Uint8Array, from: number): Uint8Array => {
	const copy = new Uint8Array(src.byteLength - from);
	copy.set(src.subarray(from));
	return copy;
};

/** Read a child pipe to EOF keeping only the last `maxBytes`. The window is
 *  line-aligned: truncation drops through the first newline of the kept
 *  window (the whole window when it holds no newline), so per-line
 *  sanitization never sees a truncated line. */
export const readBoundedTail = async (
	stream: ReadableStream<Uint8Array>,
	maxBytes = DIAGNOSTIC_TAIL_BYTES,
): Promise<BoundedTail> => {
	const reader = stream.getReader();
	const win = new BoundedTailWindow(maxBytes);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			win.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return win.finish();
};

const decodeTail = (buf: Uint8Array): string =>
	new TextDecoder("utf-8", { fatal: false }).decode(buf);
