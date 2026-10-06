import { db } from "./context.ts";
import { json } from "./helpers.ts";
import {
	laneObservationSnapshot,
	recordLaneObservation,
} from "./lane-observations.ts";

/** Host and write-token guards run in fleet-board.ts before this handler. */
export async function handleObservations(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname !== "/api/lane-observations") return null;
	if (req.method === "GET" || req.method === "HEAD")
		return json(laneObservationSnapshot(db, url.searchParams.get("project")));
	if (req.method !== "POST")
		return new Response(null, {
			status: 405,
			headers: { Allow: "GET, HEAD, POST" },
		});
	if (
		(req.headers.get("content-type") ?? "").split(";")[0].trim() !==
		"application/json"
	)
		return json(
			{ ok: false, error: "content-type must be application/json" },
			415,
		);
	try {
		const reader = req.body?.getReader();
		if (!reader)
			return json({ ok: false, error: "Observation body required" }, 400);
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 8192) {
					await reader.cancel();
					return json({ ok: false, error: "Observation exceeds 8 KiB" }, 413);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const result = recordLaneObservation(db, input);
		return json(result, result.ok ? 200 : 400);
	} catch {
		return json({ ok: false, error: "Invalid observation JSON" }, 400);
	}
}
