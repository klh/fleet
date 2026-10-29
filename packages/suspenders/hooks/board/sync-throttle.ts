// board/sync-throttle.ts — refresh floor for syncDecisions' reconciliation.
// The sync runs full-table scans over `events` (NEED% backfill, lane-stop
// NOT EXISTS over every work.claimed, enrichment) and was invoked on every
// /api/tasks and /api/decisions poll from every tab — ~1-2s of synchronous
// SQLite per call on a large governor.db, pinning the board event loop.
// Its transitions are idempotent + monotonic, so running them on a floor is
// safe: at most once per window, and only when new events arrived or the
// idle re-check window lapsed (delivery degradation is time-based). Board
// writes pass force. SUSPENDERS_BOARD_SYNC_FLOOR_MS (minimum gap between
// passes; default 0 = sync whenever the bus moved) and
// SUSPENDERS_BOARD_SYNC_IDLE_MS (default 30000) are the knobs. The floor was
// 5000 while a pass full-scanned the bus; the backfills now read only above
// the reader_cursors mark (board/reader-cursor.ts, ~4ms a pass on the
// 2026-10-29 snapshot), so a new event syncs on the next poll — the W798
// freshness contract — and an idle bus still re-checks only every 30s.

import { boardKnob } from "./board-knobs.ts";

const state: { at: number; stamp: number | string } = { at: 0, stamp: -1 };

export function shouldSync(
	stamp: number | string,
	force: boolean,
	now: number = Date.now(),
): boolean {
	if (force || state.at === 0) return true;
	const floor = boardKnob("board.sync_floor_ms");
	const age = now - state.at;
	if (age < floor) return false;
	if (stamp !== state.stamp) return true;
	return age >= boardKnob("board.sync_idle_ms");
}

export function markSynced(
	stamp: number | string,
	now: number = Date.now(),
): void {
	state.at = now;
	state.stamp = stamp;
}

/** Test seam: forget the last sync so the next call runs. */
export function resetSyncThrottle(): void {
	state.at = 0;
	state.stamp = -1;
}
