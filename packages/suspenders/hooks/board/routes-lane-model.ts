// routes-lane-model.ts — W461.3 scoped board queries over the lane/route
// read model: grouped views (immediate-downstream default), keyset detail,
// idempotent edge ingest, and the bounded server-filtered SSE push with an
// explicit resync signal. Filters are applied SERVER-side — browser
// filtering is never an authorization mechanism (doc §3).
import { db } from "./context.ts";
import { json } from "./helpers.ts";
import {
	INGEST_BATCH_CAP,
	ingestRequestEdges,
	laneModelDelta,
	laneModelDetail,
	laneModelGroups,
	parseLaneModelFilters,
} from "./lane-read-model.ts";

const STREAM_POLL_MS = 1_000;
const STREAM_HEARTBEAT_TICKS = 15;
const STREAM_SLOW_CLOSE_TICKS = 8;

function filtersOr400(
	url: URL,
): { filters: ReturnType<typeof parseLaneModelFilters> } | Response {
	const filters = parseLaneModelFilters(url);
	if (typeof filters === "string")
		return json({ ok: false, error: filters }, 400);
	return { filters };
}

async function readEdgeBatch(req: Request): Promise<unknown | Response> {
	const contentType = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim();
	if (contentType !== "application/json")
		return json(
			{ ok: false, error: "content-type must be application/json" },
			415,
		);
	const reader = req.body?.getReader();
	if (!reader)
		return json({ ok: false, error: "Observation batch required" }, 400);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 262_144) {
				await reader.cancel();
				return json(
					{ ok: false, error: "Observation batch exceeds 256 KiB" },
					413,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Bounded SSE push: snapshot first, then one bounded delta per tick. A
 * slow client's queue is bounded by closing the stream after sustained
 * backpressure — EventSource reconnects and re-snapshots. Overflow (more
 * edges in a tick than the delta window) sends the explicit resync. */
function streamResponse(
	filters: ReturnType<typeof parseLaneModelFilters>,
): Response {
	const encoder = new TextEncoder();
	let ticks = 0;
	let slowTicks = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	// default HWM is 1 — any single queued chunk reads as backpressure; a
	// real bounded queue needs room for several ticks before "slow" is true
	const queue = new CountQueuingStrategy({ highWaterMark: 64 });
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const send = (event: string, data: unknown): boolean => {
					if (controller.desiredSize !== null && controller.desiredSize <= 0)
						return false;
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
					return true;
				};
				send("snapshot", { ok: true, ...laneModelGroups(db, filters) });
				// the until window bounds history; the live tail is open-ended —
				// edges posted after subscribe carry ts > until and must flow
				const live = { ...filters, until: Number.MAX_SAFE_INTEGER };
				let cursor = (
					db
						.query("SELECT COALESCE(MAX(id), 0) AS n FROM board_request_edges")
						.get() as {
						n: number;
					}
				).n;
				timer = setInterval(() => {
					ticks++;
					try {
						if (ticks % STREAM_HEARTBEAT_TICKS === 0) {
							controller.enqueue(encoder.encode(": ping\n\n"));
							return;
						}
						const delta = laneModelDelta(db, live, cursor);
						if (delta.overflow) {
							if (send("resync", { ok: true, cursor: 0 }))
								cursor = delta.cursor;
							return;
						}
						if (delta.rows.length) {
							const delivered = send("delta", { ok: true, ...delta });
							if (delivered) {
								slowTicks = 0;
								cursor = delta.cursor;
								return;
							}
						}
						slowTicks =
							controller.desiredSize !== null && controller.desiredSize <= 0
								? slowTicks + 1
								: 0;
						if (slowTicks >= STREAM_SLOW_CLOSE_TICKS) {
							clearInterval(timer);
							// the client's queue is full: signal resync and drop the
							// stream — EventSource reconnects and re-snapshots
							controller.enqueue(
								encoder.encode(
									`event: resync\ndata: {"ok":true,"cursor":0}\n\n`,
								),
							);
							controller.close();
						}
					} catch {
						clearInterval(timer);
						try {
							controller.close();
						} catch {
							// already closed by client abort
						}
					}
				}, STREAM_POLL_MS);
			},
			cancel() {
				// client abort (EventSource closed): stop the poll timer
				if (timer) clearInterval(timer);
			},
		},
		queue,
	);
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

/** Host and write-token guards run in fleet-board.ts before this handler. */
export async function handleLaneModel(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/api/lane-model")) return null;
	if (
		url.pathname === "/api/lane-model/groups" &&
		(req.method === "GET" || req.method === "HEAD")
	) {
		const scoped = filtersOr400(url);
		if (scoped instanceof Response) return scoped;
		return json({ ok: true, ...laneModelGroups(db, scoped.filters) });
	}
	if (
		url.pathname === "/api/lane-model/detail" &&
		(req.method === "GET" || req.method === "HEAD")
	) {
		const scoped = filtersOr400(url);
		if (scoped instanceof Response) return scoped;
		const cursor = Number(url.searchParams.get("cursor")) || null;
		const limit = Number(url.searchParams.get("limit")) || 50;
		const page = laneModelDetail(db, scoped.filters, cursor, limit);
		return json({ ok: true, ...page });
	}
	if (url.pathname === "/api/lane-model/stream" && req.method === "GET") {
		const scoped = filtersOr400(url);
		if (scoped instanceof Response) return scoped;
		return streamResponse(scoped.filters);
	}
	if (url.pathname === "/api/lane-model/edges") {
		if (req.method !== "POST")
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		const body = await readEdgeBatch(req);
		if (body instanceof Response) return body;
		const result = ingestRequestEdges(db, body);
		return json(result, result.ok ? 200 : 400);
	}
	return null;
}
