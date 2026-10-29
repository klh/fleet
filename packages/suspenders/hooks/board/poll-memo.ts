// board/poll-memo.ts — refresh floor for the board's polled feeds.
// Every open tab polls /api/tasks and /api/decisions at 1s; the handlers are
// synchronous, so N tabs × a slow compute queued back-to-back and pinned the
// event loop (W2273). One compute per key per window: requests queued behind
// a compute read its result instead of recomputing. Staleness is bounded by
// the window (default 1s, SUSPENDERS_BOARD_POLL_MEMO_MS; 0 disables).
//
// The memo holds the SERIALIZED body, not the object: under 4-tab load the
// per-request JSON.stringify of a cached object cost 19.5s of a 47s profile.
// Stringify once per window, hash once (the etag), and every request in the
// window gets the same bytes — or a 304 when its If-None-Match still matches.
// The serializer + tag + 304 responder are the one etag.ts implementation.
import { boardKnob } from "./board-knobs.ts";
import { type FeedBody, etagBody } from "./etag.ts";

const memo = new Map<string, FeedBody>();

export function pollMemoBody(
	key: string,
	compute: () => unknown,
	now: number = Date.now(),
): FeedBody {
	const ttl = boardKnob("board.poll_memo_ms");
	if (ttl > 0) {
		const hit = memo.get(key);
		if (hit && now - hit.at < ttl) return hit;
	}
	// stamp AFTER the compute: the window opens when the result is fresh
	const entry = etagBody(compute());
	if (ttl > 0) {
		// keys carry the bus high-water, so superseded keys pile up: sweep
		// the expired ones before they can grow the map without bound
		if (memo.size >= 64)
			for (const [k, v] of memo) if (entry.at - v.at >= ttl) memo.delete(k);
		memo.set(key, entry);
	}
	return entry;
}

/** Drop every memoized feed — call after a board write so the next poll
 * reflects it immediately instead of up to one window later. */
export function clearPollMemo(): void {
	memo.clear();
}
