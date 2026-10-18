// prefs-lib.ts — W791: the merge-write guard for the operator prefs file
// (~/.claude/local-llm/prefs.json). Incident 2026-10-17: a belt writer
// flushed a stale in-memory snapshot back to disk and clobbered operator
// sections (kev escalate_gate + ambiguity_band, condense, cost_speed).
// Law: prefs.json is config-over-code — no writer may rewrite the whole
// file from memory. Every write goes through mergeWritePrefs: load the
// CURRENT disk state, deep-merge the writer's keys, commit atomically
// (sibling tmp + rename) and keep the file's existing mode.
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge patch over base — patch wins; nested plain objects merge
 *  recursively, arrays and scalars replace wholesale (an ambiguity band
 *  [0.14, 0.3] is data, not a merge target). Neither input is mutated. */
export const deepMergePrefs = (
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const b = out[key];
		out[key] =
			isPlainObject(b) && isPlainObject(value)
				? deepMergePrefs(b, value)
				: value;
	}
	return out;
};

/** Load-fresh + deep-merge + atomic write. Throws on a corrupt on-disk
 *  file — an unreadable operator config is never silently replaced.
 *  Returns the merged object that landed. */
export function mergeWritePrefs(
	path: string,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const current = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
		: {};
	const next = deepMergePrefs(current, patch);
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	const tmp = `${path}.${randomUUID()}.tmp`;
	// chmod (not the write mode arg) — the umask would mask 0644 down on
	// strict-umask machines and silently tighten the operator's file
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	chmodSync(tmp, mode);
	renameSync(tmp, path);
	return next;
}
