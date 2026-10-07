// hooks/lib/tool-failures.ts — in-session tool-failure retry counter with
// anti-thrash (claudecode research §1.5): counts same-key retries inside a
// 60 s window and upgrades the guidance at >=5 from "analyze before
// retrying" to "change method or ask". Noise classes (chains that handle
// their own failure, permission-denied scans, optional-startup
// method-not-found) never count. Advisory: state failures fail open —
// a lost counter only loses the guidance, never a verdict.
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "./session-state.ts";

export const FAILURE_WINDOW_MS = 60_000;
export const ANTI_THRASH_AT = 5;

export type ToolFailRecord = { n: number; first: number; last: number };
export type ToolFailState = Record<string, ToolFailRecord>;

// the retry key: tool + a stable preview of its input (first 200 chars)
export function failKey(tool: string, input: unknown): string {
	return `${tool}:${JSON.stringify(input ?? {}).slice(0, 200)}`;
}

// noise classes (OMC's, plus chain-handled failures): none of these are
// thrash — the command itself declares the failure is intentional
export function isNoise(command: string | undefined, error: string): boolean {
	if (command && /\|\|/.test(command)) return true;
	if (
		/permission denied/i.test(error) &&
		/^\s*(find|grep|rg|ls|du|cat)\b/.test(command ?? "")
	)
		return true;
	if (/^method not found/i.test(error.trim())) return true;
	return false;
}

export function recordToolFailure(
	sid: string,
	tool: string,
	input: unknown,
	error: string,
): { count: number; guidance: string | null } {
	const file = sessionStatePath("toolfail", sid);
	const key = failKey(tool, input);
	const state = readSessionState<ToolFailState>(file) ?? {};
	const now = Date.now();
	const prev = state[key];
	const fresh =
		!prev ||
		typeof prev.n !== "number" ||
		now - (prev.last ?? 0) > FAILURE_WINDOW_MS;
	const n = fresh ? 1 : prev.n + 1;
	state[key] = { n, first: fresh ? now : prev.first, last: now };
	// keep the file bounded: drop windows that can no longer matter
	for (const k of Object.keys(state))
		if (now - state[k].last > FAILURE_WINDOW_MS) delete state[k];
	writeSessionState(file, state); // false = fail open, counter just resets
	if (n < 3) return { count: n, guidance: null };
	if (n < ANTI_THRASH_AT)
		return {
			count: n,
			guidance: `tool-failures: ${tool} failed ${n}x in 60s — analyze the error and change one thing before retrying.`,
		};
	return {
		count: n,
		guidance: `Anti-thrash (${tool}): ${n} identical failures in 60s — stop retrying the same approach. Re-read the error, change method, or coord consult --best "<command, error, attempts>" before another attempt.`,
	};
}
