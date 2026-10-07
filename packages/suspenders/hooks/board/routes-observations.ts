import { db } from "./context.ts";
import { json } from "./helpers.ts";
import {
	laneObservationSnapshot,
	recordLaneObservation,
} from "./lane-observations.ts";
import { LaneProjection } from "../../../buckle/src/projection.ts";

function numParam(url: URL, name: string): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || !/^\d+$/.test(raw)) return null;
	return Number(raw);
}

/** W461 stage 3: scoped lane/route read model over buckle's projection db
 *  (KLH_LANE_ROUTES_DB, config-over-code). Unset = 404 honestly. GET-only:
 *  the projection is written by buckle's ingest, never by the board. */
function handleLaneRoutes(req: Request, url: URL): Response | null {
	if (req.method !== "GET" && req.method !== "HEAD") return null;
	const path = process.env.KLH_LANE_ROUTES_DB;
	if (!path)
		return json(
			{ ok: false, error: "lane routes db not configured (KLH_LANE_ROUTES_DB)" },
			404,
		);
	let projection: LaneProjection | null = null;
	try {
		projection = new LaneProjection(path);
		return json(
			projection.snapshot({
				origin: url.searchParams.get("origin") || null,
				since: numParam(url, "since"),
				until: numParam(url, "until"),
				errorOnly: url.searchParams.get("errors") === "1",
				limit: numParam(url, "limit") ?? undefined,
				cursor: url.searchParams.get("cursor"),
			}),
		);
	} catch {
		return json({ ok: false, error: "lane routes db unavailable" }, 503);
	} finally {
		projection?.close();
	}
}

/** Host and write-token guards run in fleet-board.ts before this handler. */
export async function handleObservations(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/lane-routes") return handleLaneRoutes(req, url);
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
