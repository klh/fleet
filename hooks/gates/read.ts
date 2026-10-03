// hooks/gates/read.ts — PreToolUse(Read) fat-read + re-read guard (W110),
// W252 auto-clamp + data-file rule:
//   1. FAT-READ DENY, now auto-clamping: a no-limit Read of a file >
//      SUSPENDERS_MAX_READ bytes (default 40KB) is denied BEFORE the harness
//      reads it — W109 measured 23 results >60KB in 7d (max 122KB) from
//      1,412 no-offset reads. The deny reason carries the size, the bounded
//      retry, AND the clamped head+tail view (lib/clamp.ts), so a fat read
//      costs one round trip instead of deny→reissue→re-read. Media
//      extensions are exempt (Read has no limit for images/PDFs).
//   2. DATA-FILE RULE (.jsonl/.log): a limit only bounds LINES — a bounded
//      read of fat records still busts the cap. Data files with a limit get
//      a slice measure (O(file ≤ READ_MEASURE_MAX, anchor-gate law) and a
//      data-specific deny with the clamped slice when it exceeds the cap.
//   3. RE-READ NUDGE: 3rd+ Read of the same path in one session gets a
//      non-blocking additionalContext nudge (the fleet-loop.ts 37x case).
//      Advisory: SUSPENDERS_REREAD_NUDGE=0 disables.
import { deny, nudge, type HookInput } from "../lib/hookio.ts";
import { bumpPathCount } from "../lib/gatestate.ts";
import { clampHeadTail, readSliceLines } from "../lib/clamp.ts";
import { readFileSync, statSync } from "node:fs";

export const DEFAULT_MAX_READ = 40 * 1024;

const MEDIA_RE = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff|pdf|avif)$/i;

// Feed files the re-read nudge + data-slice rule treat specially.
const DATA_RE = /\.(jsonl|log)$/i;

// Above: fail open (anchor-gate law) — the harness owns monsters. Bounds
// both the clamp read and the data-slice measure.
const READ_MEASURE_MAX = 8 * 1024 * 1024;

/** SUSPENDERS_MAX_READ parsing — same contract as mutationCap: unset/blank →
 * default; a positive integer is the cap in bytes; 0, negatives, garbage →
 * disabled (the knob was touched deliberately). */
export function readCapBytes(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_READ;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Pure core of the fat-read deny: null = allow, else the deny reason. */
export function fatReadDeny(
	size: number,
	hasLimit: boolean,
	cap: number,
	path: string,
): string | null {
	if (cap === 0 || hasLimit || size <= cap) return null;
	if (MEDIA_RE.test(path)) return null;
	const kb = Math.round(size / 1024);
	return `read-gate: ${path} is ${kb}KB — a no-limit Read pulls it ALL into context. Re-issue with limit (e.g. limit: 400) and offset, or rg for a targeted search. Escape hatch: SUSPENDERS_MAX_READ=<bytes> raises the cap, 0 disables.`;
}

/** W252 auto-clamp: append the head+tail view to a deny reason. Pure —
 * text already in hand (file read or slice measured). Returns the base
 * untouched when nothing elides: the bare deny still carries size +
 * bounded-retry guidance. */
function clampSuffix(base: string, text: string, cap: number): string {
	const clamped = clampHeadTail(text, cap);
	if (!clamped) return base;
	return `${base}\n--- clamped head+tail view (auto-clamped, cap ${Math.round(cap / 1024)}KB) ---\n${clamped.text}`;
}

/** File-reading wrapper: monsters and unreadable files fail open to the
 * bare deny (anchor-gate law — the harness owns what we cannot bound). */
function clampedFileView(
	F: string,
	size: number,
	cap: number,
	base: string,
): string {
	if (cap <= 0 || size > READ_MEASURE_MAX) return base;
	let text: string;
	try {
		text = readFileSync(F, "utf8");
	} catch {
		return base; // raced delete → bare deny; harness's own error is precise
	}
	return clampSuffix(base, text, cap);
}

/** W252 data-file rule: a limit bounds lines, not bytes — fat records
 * (.jsonl/.log) still bust the cap through a bounded read. Pure decision:
 * null = allow, else the deny reason. */
export function dataSliceDeny(
	sliceBytes: number,
	limit: number,
	cap: number,
	path: string,
): string | null {
	if (cap === 0 || sliceBytes <= cap) return null;
	const kb = Math.round(sliceBytes / 1024);
	return `read-gate: ${path} slice (limit: ${limit}) is ${kb}KB — even bounded reads of .jsonl/.log stay under the cap. Re-issue with a smaller limit, or tail/rg/jq for the records you want. Escape hatch: SUSPENDERS_MAX_READ=<bytes> raises the cap, 0 disables.`;
}

/** 3rd+ same-path read in a session → advisory nudge, read proceeds. */
export function rereadNudge(sid: string, F: string, label: string): void {
	if (process.env.SUSPENDERS_REREAD_NUDGE === "0") return;
	const n = bumpPathCount("reads", sid, F);
	if (n < 3 || n % 3 !== 0) return;
	nudge(
		`read-gate: read #${n} of ${label} this session — it is already in context. If the file changed under you, the anchor-gate denial carries the current text; prefer rg/offset+limit over full re-reads.`,
	);
}

export function readGate(hook: HookInput): void {
	if (hook.tool_name !== "Read") return;
	const ti = (hook.tool_input ?? {}) as {
		file_path?: string;
		limit?: number | string;
		offset?: number | string;
	};
	const F = ti.file_path ?? "";
	if (!F) return;
	const hasLimit = ti.limit !== undefined && ti.limit !== null;
	let size: number;
	try {
		size = statSync(F).size;
	} catch {
		return; // missing/unreadable → harness's own error, precise and cheap
	}
	const cap = readCapBytes(process.env.SUSPENDERS_MAX_READ);
	const reason = fatReadDeny(size, hasLimit, cap, F);
	if (reason) deny(clampedFileView(F, size, cap, reason));
	if (hasLimit && DATA_RE.test(F) && cap > 0 && size <= READ_MEASURE_MAX) {
		// W252 data-file rule: a limit bounds lines, not bytes — measure the
		// slice this read would actually deliver and clamp it when it is fat.
		const limit = Number(ti.limit ?? 0);
		const offset = Number(ti.offset ?? 0);
		if (Number.isFinite(limit) && limit > 0) {
			let text: string;
			try {
				text = readFileSync(F, "utf8");
			} catch {
				return; // raced delete → harness's own error, precise and cheap
			}
			const slice = readSliceLines(text, offset, limit);
			const sliceReason = dataSliceDeny(
				Buffer.byteLength(slice),
				limit,
				cap,
				F,
			);
			if (sliceReason) deny(clampSuffix(sliceReason, slice, cap));
		}
	}
	const sid = (hook as HookInput & { session_id?: string }).session_id;
	if (!sid) return;
	rereadNudge(sid, F, F.slice(F.lastIndexOf("/") + 1));
}
