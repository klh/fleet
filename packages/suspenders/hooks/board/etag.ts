// hooks/board/etag.ts — HTTP citizenship for the polled board feeds
// (/api/data, /api/decisions, /api/tasks, /api/spend-series): a weak ETag
// over the body MINUS the top-level `ts` response stamp, so an unchanged
// slice answers If-None-Match with a bodyless 304 instead of re-sending the
// same JSON every poll. Dependency-free (helpers.ts re-exports it) so the
// unit spec never opens the governor store.
//
// ONE stringify per body: the ts-less basis is serialized once, hashed, and
// the wire body is that basis with `ts` spliced back in front — the poll
// memo (poll-memo.ts) caches the result, so every request in a window
// reuses the same bytes + tag and a 304 costs no serialization at all.
import { createHash } from "node:crypto";

export type FeedBody = { at: number; body: string; etag: string };

export function etagBody(data: unknown, at: number = Date.now()): FeedBody {
	let body: string;
	let basis: string;
	if (
		data !== null &&
		typeof data === "object" &&
		!Array.isArray(data) &&
		typeof (data as { ts?: unknown }).ts === "number"
	) {
		const { ts, ...rest } = data as { ts: number };
		basis = JSON.stringify(rest);
		body = basis === "{}" ? `{"ts":${ts}}` : `{"ts":${ts},${basis.slice(1)}`;
	} else {
		body = basis = JSON.stringify(data);
	}
	const hash = createHash("sha1").update(basis).digest("base64url");
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
