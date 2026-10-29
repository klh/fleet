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

export type MemoBody = { at: number; body: string; etag: string };

const memo = new Map<string, MemoBody>();

const windowMs = (): number => {
	const raw = Number(process.env.SUSPENDERS_BOARD_POLL_MEMO_MS ?? 1000);
	return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
};

/** One serialization + etag for a value — the shape every cached feed serves. */
export function serializeBody(
	value: unknown,
	at: number = Date.now(),
): MemoBody {
	const body = JSON.stringify(value);
	return { at, body, etag: `"${Bun.hash(body).toString(36)}"` };
}

export function pollMemoBody(
	key: string,
	compute: () => unknown,
	now: number = Date.now(),
): MemoBody {
	const ttl = windowMs();
	if (ttl > 0) {
		const hit = memo.get(key);
		if (hit && now - hit.at < ttl) return hit;
	}
	// stamp AFTER the compute: the window opens when the result is fresh
	const entry = serializeBody(compute());
	if (ttl > 0) {
		// keys carry the bus high-water, so superseded keys pile up: sweep
		// the expired ones before they can grow the map without bound
		if (memo.size >= 64)
			for (const [k, v] of memo) if (entry.at - v.at >= ttl) memo.delete(k);
		memo.set(key, entry);
	}
	return entry;
}

/** Serve a pre-serialized feed body: the cached bytes ride as-is, and a
 * matching If-None-Match answers 304 with no body at all. */
export function jsonBody(
	req: Request,
	cached: { body: string; etag: string },
): Response {
	const headers = {
		"content-type": "application/json",
		etag: cached.etag,
		"cache-control": "no-cache",
	};
	// substring match on the bare hash: a compressing front (Caddy encode)
	// may hand the client a weakened or suffixed form of the same tag
	const inm = req.headers.get("if-none-match");
	if (inm?.includes(cached.etag.slice(1, -1)))
		return new Response(null, { status: 304, headers });
	return new Response(cached.body, { status: 200, headers });
}

/** Drop every memoized feed — call after a board write so the next poll
 * reflects it immediately instead of up to one window later. */
export function clearPollMemo(): void {
	memo.clear();
}
