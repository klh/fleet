import type { GovernorStore } from "./govdb.ts";

export function expireObservedLease(
	store: GovernorStore,
	observed: { path: string; sid: string; ts: number },
	now: number,
	ttlMs: number,
): boolean {
	if (now - observed.ts <= ttlMs) return false;
	// A renewal by the SAME owner is a different observed lease generation.
	// The conditional DELETE is one atomic store operation, including expiry.
	return (
		store
			.query("DELETE FROM locks WHERE path=? AND sid=? AND ts=? AND ts<?")
			.run(observed.path, observed.sid, observed.ts, now - ttlMs).changes > 0
	);
}
