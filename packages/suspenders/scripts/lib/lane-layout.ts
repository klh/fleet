// scripts/lib/lane-layout.ts — W1139.2 lane layout law. The lane prompt is
// composed in ONE stable order — global (system + tools) → project
// (AGENTS.md, read by the agent at runtime) → session (lane identity + brief)
// → messages — and the SHARED layer never carries churn: a timestamp, a
// per-lane sid, or a machine-local path inside the shared prefix makes every
// lane re-pay the full prefix cold. Source doctrine: Anthropic's prompt-
// caching lessons (source read 2026-10-22), fleet-mapped onto the
// starter-seed surface (lane-starter.ts). Enforcement is BY CONSTRUCTION:
// the seeding gate refuses a churn-carrying prefix before a starter session
// can be versioned, and retake/compaction continuations compose as
// identical-prefix + appended summary instruction — never a re-orientation.

/** Prefix churn hazards for the SHARED layer (fleet-mapped breakage list):
 *  ISO dates/timestamps (a clock in the prefix), per-lane worktree paths,
 *  per-lane sids (every fleet sid opens `autow`), machine-local home paths
 *  (also scrub-banned). Case-sensitive on purpose: the fixed orientation
 *  text never upper-cases these tokens. */
export const PREFIX_CHURN_PATTERN =
	/\b20\d{2}-\d{2}-\d{2}\b|\.worktrees\/|\/Users\/|\bautow/;

/** Refuse churn in the shared prefix — throws with the matched hazard.
 *  Sits beside the W454 secret guard at the seeding gate. */
export const assertStablePrefix = (seed: string): void => {
	const hit = seed.match(PREFIX_CHURN_PATTERN);
	if (hit)
		throw new Error(
			`lane layout law refused — prefix churn hazard in the shared seed: ${hit[0]}`,
		);
};

/** The layout-law bullet riding the shared orientation seed itself — STABLE
 *  text (a version of the seed IS this text; it must never carry churn, the
 *  gate above proves it at seed time). */
export const LAYOUT_LAW_BULLET =
	"- Prefix layout law: the shared prefix (system + tools + this orientation) is CACHE-CRITICAL — per-lane identity, timestamps and worktree paths ride AFTER the fork, never inside shared history; mode changes ride reminder messages, never tool add/remove mid-session.";

/** Compaction/retake continuation: IDENTICAL prefix + appended summary
 *  instruction — the ~10x-cheaper continuation shape. `base` must be the
 *  unchanged shared prefix (seed orientation or the forked identity block);
 *  the session-specific summary is APPENDED, never interleaved. */
export const continuationPrompt = (base: string, summary: string): string =>
	`${base}\n\nCONTINUATION (compaction fork): the context above is IDENTICAL to the session this lane continues — do not re-orient. Progress summary follows; continue from it.\nSUMMARY: ${summary}`;
