import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Last `n` non-empty lines of a text file, reading only a bounded tail
 *  window (grown until it holds n+1 lines, the file start, or maxBytes)
 *  instead of the whole growing NDJSON log (streams-over-buffers, W714).
 *  Missing/unreadable file → []. */
export function tailLines(
	path: string,
	n: number,
	maxBytes = 1 << 20,
): string[] {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return [];
	}
	try {
		const size = fstatSync(fd).size;
		let want = 16 * 1024;
		for (;;) {
			const len = Math.min(size, want);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			const lines = buf.toString("utf8").split("\n");
			// a window starting mid-file begins with a partial line
			if (len < size) lines.shift();
			const kept = lines.filter((l) => l.trim() !== "");
			if (kept.length > n || len >= size || len >= maxBytes)
				return kept.slice(-n);
			want *= 4;
		}
	} finally {
		closeSync(fd);
	}
}
