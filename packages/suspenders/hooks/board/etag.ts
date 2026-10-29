// hooks/board/etag.ts — HTTP citizenship for the polled board feeds
// (/api/data, /api/decisions, /api/tasks, /api/spend-series): a weak ETag
// over the body MINUS its build stamps and relative ages, so an unchanged
// slice answers If-None-Match with a bodyless 304 instead of re-sending the
// same JSON every poll. Dependency-free (helpers.ts re-exports it) so the
// unit spec never opens the governor store.
//
// The poll memo (poll-memo.ts) caches the result, so the body + the hashed
// basis serialize once per window, every request in the window reuses the
// same bytes + tag, and a 304 costs no serialization at all.
import { createHash } from "node:crypto";

export type FeedBody = { at: number; body: string; etag: string };

// Fields that move every build without the feed changing: top-level build
// stamps, and every relative age (`*Ago`, `age_s`) — those ride beside an
// absolute stamp the client re-derives them from (board-html/feed-ages.ts),
// so a 304 never freezes an age on screen.
const VOLATILE_TOP = new Set(["ts", "decisionsTs", "observation"]);
const RELATIVE_AGE = /Ago$|^age_s$/;

export function etagBody(data: unknown, at: number = Date.now()): FeedBody {
	const body = JSON.stringify(data);
	const top = data !== null && typeof data === "object" ? data : null;
	const lane = (top as { laneObservations?: unknown } | null)?.laneObservations;
	const basis = JSON.stringify(data, function (this: unknown, k, v) {
		if (RELATIVE_AGE.test(k)) return undefined;
		if (this === top && VOLATILE_TOP.has(k)) return undefined;
		if (this === lane && k === "ts") return undefined;
		return v;
	});
	const hash = createHash("sha1")
		.update(basis ?? "")
		.digest("base64url");
	return { at, body, etag: `W/"${hash.slice(0, 22)}"` };
}

/** Serve a serialized feed body; a matching If-None-Match answers 304. The
 * match is on the bare hash, so a front that re-weakens or suffixes the tag
 * (Caddy encode: `-gzip`) still revalidates. */
export function respondCached(req: Request, cached: FeedBody): Response {
	const headers = { etag: cached.etag, "cache-control": "no-cache" };
	const inm = req.headers.get("if-none-match");
	if (inm?.includes(cached.etag.slice(3, -1)))
		return new Response(null, { status: 304, headers });
	return new Response(cached.body, {
		headers: { ...headers, "content-type": "application/json" },
	});
}

export function jsonEtag(req: Request, data: unknown): Response {
	return respondCached(req, etagBody(data));
}
