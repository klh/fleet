// hooks/lib/clamp.ts — W252 tool-result auto-clamp core: head+tail elision.
// Harness 2.1.283 has no updatedToolResponse (W110 verified), so a hook
// cannot shrink a delivered result — deny-and-reissue is the reachable form.
// The read gate embeds the clamped view in its deny reason: one round trip
// replaces deny→reissue→re-read. Pure string → string; no env, no I/O.
// Slices are byte-exact (Buffer) and line-snapped: a JSONL record or log
// line never splits mid-token.

export type Clamped = {
	text: string; // head + marker + tail
	elidedBytes: number;
	elidedLines: number;
};

// Marker text budget inside the cap (head + marker + tail must fit).
const MARKER_RESERVE = 320;

const kb = (bytes: number): number => Math.round(bytes / 1024);

/** Move a byte index forward past any UTF-8 continuation bytes. */
function snapForward(buf: Buffer, i: number): number {
	while (i < buf.length && (buf[i] ?? 0) >= 0x80 && (buf[i] ?? 0) < 0xc0) i++;
	return i;
}

/** Last index ≤ end where a line ends (the \n itself); 0 if none. */
function lastLineEnd(buf: Buffer, end: number): number {
	let i = end;
	while (i > 0 && buf[i - 1] !== 0x0a) i--;
	return i;
}

/** First line-start index ≥ start; buf.length if none remains. */
function nextLineStart(buf: Buffer, start: number): number {
	let i = snapForward(buf, start);
	while (i < buf.length && buf[i] !== 0x0a) i++;
	return i < buf.length ? i + 1 : buf.length;
}

function countNewlines(buf: Buffer, from: number, to: number): number {
	let n = 0;
	for (let i = from; i < to; i++) if (buf[i] === 0x0a) n++;
	return n;
}

/**
 * Head+tail elision to cap bytes. Returns null when no clamp is needed
 * (≤ cap, or cap ≤ 0 = disabled). The marker carries honest accounting so
 * the model knows exactly what the middle holds and how to page it.
 */
export function clampHeadTail(text: string, cap: number): Clamped | null {
	if (cap <= 0) return null;
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= cap) return null;
	const half = Math.floor((cap - MARKER_RESERVE) / 2);
	if (half <= 0) return null; // degenerate cap — refuse to clamp into nothing

	// Head: cut at half, codepoint-snapped, then back to a line end. A giant
	// single line (no newline in budget) keeps the raw cut.
	let h = snapForward(buf, Math.min(half, buf.length));
	const lineH = lastLineEnd(buf, h);
	if (lineH > 0) h = lineH;

	// Tail: from total-half to the next line start. Falls back to the raw
	// cut when the rest is one line; drops out entirely when it would
	// overlap the head (one line fatter than the whole budget).
	let t = nextLineStart(buf, Math.max(h, buf.length - half));
	if (t >= buf.length) t = Math.max(h, buf.length - half);
	if (t <= h) t = buf.length; // overlap → head-only clamp, tail empty

	const elidedBytes = t - h;
	const elidedLines = countNewlines(buf, h, t);
	const marker = `[clamp-gate: ${kb(elidedBytes)}KB / ${elidedLines} lines elided here — re-issue with offset+limit or rg to page the middle]`;
	const tail = t >= buf.length ? "" : buf.subarray(t).toString("utf8");
	const text2 = `${buf.subarray(0, h).toString("utf8")}\n${marker}\n${tail}`;
	return { text: text2, elidedBytes, elidedLines };
}

/**
 * The slice a Read(path, offset, limit) would deliver: lines
 * [offset, offset+limit), 0-based (±1 line is irrelevant to a size bound).
 * Splits once — the gate only calls this for .jsonl/.log with a limit
 * (two extensions, O(file ≤ 8MB, anchor-gate law), never the hot path).
 */
export function readSliceLines(
	text: string,
	offset: number,
	limit: number,
): string {
	const lines = text.split("\n");
	return lines.slice(offset, offset + limit).join("\n");
}
