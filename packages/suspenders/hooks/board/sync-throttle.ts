// board/sync-throttle.ts — refresh floor for syncDecisions' reconciliation.
// The sync runs full-table scans over `events` (NEED% backfill, lane-stop
// NOT EXISTS over every work.claimed, enrichment) and was invoked on every
// /api/tasks and /api/decisions poll from every tab — ~1-2s of synchronous
// SQLite per call on a large governor.db, pinning the board event loop.
// Its transitions are idempotent + monotonic, so running them on a floor is
// safe: at most once per window, and only when new events arrived or the
// idle re-check window lapsed (delivery degradation is time-based). Board
// writes pass force. SUSPENDERS_BOARD_SYNC_FLOOR_MS (default 5000; 0 = every
// call) and SUSPENDERS_BOARD_SYNC_IDLE_MS (default 30000) are the knobs.

const knob = (name: string, fallback: number): number => {
	const raw = Number(process.env[name] ?? fallback);
	return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

const state = { at: 0, maxEventId: -1 };

export function shouldSync(
	maxEventId: number,
	force: boolean,
	now: number = Date.now(),
): boolean {
	if (force || state.at === 0) return true;
	const floor = knob("SUSPENDERS_BOARD_SYNC_FLOOR_MS", 5000);
	const age = now - state.at;
	if (age < floor) return false;
	if (maxEventId !== state.maxEventId) return true;
	return age >= knob("SUSPENDERS_BOARD_SYNC_IDLE_MS", 30_000);
}

export function markSynced(maxEventId: number, now: number = Date.now()): void {
	state.at = now;
	state.maxEventId = maxEventId;
}

/** Test seam: forget the last sync so the next call runs. */
export function resetSyncThrottle(): void {
	state.at = 0;
	state.maxEventId = -1;
}
