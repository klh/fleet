// hooks/lib/gatestate.ts — per-session advisory counters for gate nudges.
// Two consumers (files.ts edit-streak, read.ts re-read nudge): one counter
// shape — JSON map path → count, keyed `claude-<scope>-<sid>.json` via the
// shared atomic IO (session-state.ts). Advisory only: a state failure must
// never change a gate verdict.
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "./session-state.ts";

/** Bump and return the per-(session, path) counter. Corrupt/missing state
 * counts from zero; write failures are swallowed (nudges are advisory). */
export function bumpPathCount(
	scope: string,
	sid: string,
	path: string,
): number {
	const file = sessionStatePath(scope, sid);
	const counts = readSessionState<Record<string, number>>(file) ?? {};
	counts[path] = (counts[path] ?? 0) + 1;
	writeSessionState(file, counts);
	return counts[path];
}
