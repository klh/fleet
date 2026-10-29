// hooks/board/etag.ts — HTTP citizenship for the polled board feeds
// (/api/data, /api/decisions, /api/tasks, /api/spend-series): a weak ETag
// over the body MINUS the top-level `ts` response stamp, so an unchanged
// slice answers If-None-Match with a bodyless 304 instead of re-sending the
// same JSON every poll. Dependency-free (helpers.ts re-exports it) so the
// unit spec never opens the governor store.
import { createHash } from "node:crypto";

export function jsonEtag(req: Request, data: unknown): Response {
	const body = JSON.stringify(data);
	const stamped =
		data !== null &&
		typeof data === "object" &&
		typeof (data as { ts?: unknown }).ts === "number";
	const basis = stamped ? JSON.stringify({ ...data, ts: 0 }) : body;
	const hash = createHash("sha1").update(basis).digest("base64url");
	const etag = `W/"${hash.slice(0, 22)}"`;
	const headers = { etag, "cache-control": "no-cache" };
	if (req.headers.get("if-none-match") === etag)
		return new Response(null, { status: 304, headers });
	return new Response(body, {
		headers: { ...headers, "content-type": "application/json" },
	});
}
