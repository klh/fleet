// hooks/lib/context-pressure.ts — W510: transcript-tail context estimate for
// the Stop gate. Reads the last 64KB of the session transcript with
// fs.readSync at an offset — NEVER BunFile.slice(-n).text(), which returns
// silently empty past ~2KB on this Bun (2026-10-07, live-proven). The newest
// assistant usage row (input + cache_read + cache_creation) approximates the
// live context; thresholds are fleet config, not code constants.
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
export type Pressure = { pct: number | null; aborted: boolean };

const CACHE = `${process.env.HOME ?? ""}/.cache/claude-governor/ctx-guard`;

function num(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const WARN_PCT = () => num("KLH_CTX_WARN_PCT", 70);
export const CRITICAL_PCT = () => num("KLH_CTX_CRITICAL_PCT", 85);
// >=95% is context-limit territory: a stop here is most likely the limit
// itself — blocking would deadlock the compaction that must run next. The
// floor stays code, not config.
const HARD_FLOOR = 95;

const TAIL_BYTES = 64_000;
const ABORT_WINDOW = 20; // parseable tail lines scanned for abort markers

// Bounded tail read at a byte offset — the one file-read seam for the
// estimator and the abort scan alike.
export function readTail(path: string, bytes = TAIL_BYTES): string {
	if (!path || !existsSync(path)) return "";
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const n = Math.min(bytes, size);
		const buf = Buffer.alloc(n);
		readSync(fd, buf, 0, n, size - n);
		return buf.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

// User aborts and API errors must never be blocked — a Stop-hook block on
// either deadlocks the session. Both land in the transcript (synthetic
// "Request interrupted" user rows, isApiErrorMessage rows). Scan a small
// window of tail lines for the markers; markers absent in a given CC build
// simply never trip — stop_hook_active, the once-per-session dedup, and
// HARD_FLOOR remain the loop guards.
export function abortedIn(tail: string): boolean {
	const ls = tail.split("\n").filter(Boolean);
	let seen = 0;
	for (let i = ls.length - 1; i >= 0 && seen < ABORT_WINDOW; i--) {
		try {
			JSON.parse(ls[i]);
		} catch {
			continue;
		}
		seen++;
		if (
			ls[i].includes('"isApiErrorMessage":true') ||
			ls[i].includes("Request interrupted")
		)
			return true;
	}
	return false;
}

// The newest assistant usage row: input + cache_read + cache_creation is the
// live prompt size. Window from env (KLH_CTX_WINDOW_TOKENS, default 200k).
export function estimateContext(
	tail: string,
	windowTokens: number,
): number | null {
	if (!windowTokens) return null;
	const ls = tail.split("\n");
	for (let i = ls.length - 1; i >= 0; i--) {
		try {
			const j = JSON.parse(ls[i]) as {
				message?: {
					usage?: {
						input_tokens?: number;
						cache_read_input_tokens?: number;
						cache_creation_input_tokens?: number;
					};
				};
			};
			const u = j.message?.usage;
			if (!u) continue;
			const t =
				(u.input_tokens ?? 0) +
				(u.cache_read_input_tokens ?? 0) +
				(u.cache_creation_input_tokens ?? 0);
			return Math.round((t / windowTokens) * 100);
		} catch {}
	}
	return null;
}

// Stop-gate verdict: which pressure band this stop lands in and whether it
// has already fired once for this session+band. Null = stand down (missing
// inputs, continuation, abort, or >=HARD_FLOOR).
export function stopPressure(
	h: PressureInput,
	windowTokens = num("KLH_CTX_WINDOW_TOKENS", 200_000),
): { band: "warn" | "critical"; pct: number; message: string } | null {
	if (h.stop_hook_active) return null;
	const tail = readTail(h.transcript_path ?? "");
	if (!tail) return null;
	if (abortedIn(tail)) return null;
	const pct = estimateContext(tail, windowTokens);
	if (pct === null || pct >= HARD_FLOOR) return null;
	const warn = WARN_PCT();
	const crit = CRITICAL_PCT();
	const band = pct >= crit ? "critical" : pct >= warn ? "warn" : null;
	if (!band) return null;
	const marker = join(CACHE, `${h.session_id ?? ""}.${band}`);
	if (existsSync(marker)) return null;
	try {
		mkdirSync(CACHE, { recursive: true });
		writeFileSync(marker, new Date().toISOString());
	} catch {
		// fail-open: a dedup-marker write failure must never block a stop
	}
	return {
		band,
		pct,
		message:
			band === "warn"
				? `CONTEXT PRESSURE ~${pct}%: checkpoint now — bank a capsule (coord capsule set --as <sid> --checkpoint=<branch-head|none> --done --next), commit landed work. Fires once.`
				: `CONTEXT PRESSURE ~${pct}% (critical): bank the lane capsule NOW and run /compact before more work — in-flight state dies with compaction. Fires once.`,
	};
}
