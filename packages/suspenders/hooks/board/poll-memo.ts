// board/poll-memo.ts — refresh floor for the board's polled feeds.
// Every open tab polls /api/tasks and /api/decisions at 1s; the handlers are
// synchronous, so N tabs × a slow compute queued back-to-back and pinned the
// event loop (W2273). One compute per key per window: requests queued behind
// a compute read its result instead of recomputing. Staleness is bounded by
// the window (default 1s, SUSPENDERS_BOARD_POLL_MEMO_MS; 0 disables).

const memo = new Map<string, { at: number; value: unknown }>();

const windowMs = (): number => {
	const raw = Number(process.env.SUSPENDERS_BOARD_POLL_MEMO_MS ?? 1000);
	return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
};

export function pollMemo<T>(
	key: string,
	compute: () => T,
	now: number = Date.now(),
): T {
	const ttl = windowMs();
	if (ttl > 0) {
		const hit = memo.get(key);
		if (hit && now - hit.at < ttl) return hit.value as T;
	}
	const value = compute();
	// stamp AFTER the compute: the window opens when the result is fresh
	if (ttl > 0) memo.set(key, { at: Date.now(), value });
	return value;
}

/** Drop every memoized feed — call after a board write so the next poll
 * reflects it immediately instead of up to one window later. */
export function clearPollMemo(): void {
	memo.clear();
}
