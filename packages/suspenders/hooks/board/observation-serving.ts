// hooks/board/observation-serving.ts — W621.2: board serving surfaces for
// the W621.1 observation plane (hooks/lib/observation-plane.ts): scoped
// projection queries, the bounded server-filtered SSE push, and the batch
// ingest that feeds the read model. All scope filtering is SERVER-side —
// browser filtering is never an authorization model (arch doc §3).
// Visibility: the redacted "observes" view (counts, latency, no per-lane
// detail) is open and the default; "owns"/"authorized" detail rides the
// per-install write token — the operator at this board is the authority —
// until stage-3 viewer identity replaces the escalation shortcut.

import type { Database } from "bun:sqlite";
import type { GovernorStore } from "../lib/govdb.ts";
import { db } from "./context.ts";
import { json, readJsonCapped } from "./helpers.ts";
import { tokenOk } from "../lib/host-guard.ts";
import {
	ingestObservations,
	observationStoreId,
	projectLanes,
	type IngestResult,
	type LaneSummary,
	type ViewerScope,
} from "../lib/observation-plane.ts";

/** board-side retention on the events read model: old evidence ages out at
 * an explicit cap — the projection stays bounded (§3), never silently
 * unbounded. The lib's outbox cap covers the local failure domain; this
 * covers the serving one. */
export const OBSERVATION_EVENTS_RETENTION = 10_000;
export const OBSERVATION_INGEST_BATCH_CAP = 200;
export const OBSERVATION_BODY_CAP = 262_144;
export const OBSERVATION_LANES_LIMIT = 200;
export const OBSERVATION_LANES_LIMIT_MAX = 500;
export const OBSERVATION_SCOPE_PROJECTS_CAP = 64;

const STREAM_POLL_MS = 1_000;
const STREAM_HEARTBEAT_TICKS = 15;
const STREAM_SLOW_CLOSE_TICKS = 8;

// the lib is Database-typed (W621.1 contract); the board binding is the
// GovernorStore seam — the statement shape is the port (govdb.ts law), so
// the cast is a transport swap, not a type lie.
const asDb = (store: GovernorStore): Database => store as unknown as Database;

/** Parse + bound the viewer scope from the URL. observes (default) is the
 * redacted open view; authorized FAILS CLOSED without an explicit project
 * scope, and scopes ride the same json_each flag pattern the lib projects
 * with (bun:sqlite rejects a leading null positional). */
export function parseViewerScope(url: URL): ViewerScope | string {
	const visibility = url.searchParams.get("visibility") ?? "observes";
	if (
		visibility !== "observes" &&
		visibility !== "authorized" &&
		visibility !== "owns"
	)
		return "Invalid visibility (observes | authorized | owns)";
	const raw = url.searchParams.get("projects");
	let projectIds: string[] | undefined;
	if (raw !== null) {
		projectIds = raw
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (projectIds.length > OBSERVATION_SCOPE_PROJECTS_CAP)
			return `Project scope exceeds ${OBSERVATION_SCOPE_PROJECTS_CAP} projects`;
	}
	if (visibility === "authorized" && !(projectIds && projectIds.length > 0))
		return "authorized visibility requires a projects scope";
	return projectIds ? { visibility, projectIds } : { visibility };
}

/** The operator at this board is the authority: owns/authorized detail rides
 * the per-install write token; the redacted observes view needs nothing. */
export function viewerAuthorized(req: Request, scope: ViewerScope): boolean {
	return scope.visibility === "observes" || tokenOk(req);
}

export interface ObservationIngest {
	ok: true;
	result: IngestResult;
	/** the serving install's observer identity — local producers flushing
	 * their outbox through the plane stamp events with it; the authority
	 * check inside projectLanes keys on it */
	store: string;
}

/** Batch ingest through the W621.1 lib (idempotent on (source, id), stale
 * generations rejected, gaps reported) plus board-side retention. */
export function ingestBoardObservations(
	governor: GovernorStore,
	body: unknown,
	now = Date.now(),
): { ok: false; error: string } | ObservationIngest {
	if (!body || typeof body !== "object" || Array.isArray(body))
		return { ok: false, error: "Expected {events: [...]}" };
	const events = (body as { events?: unknown }).events;
	if (!Array.isArray(events))
		return { ok: false, error: "Expected {events: [...]}" };
	if (events.length > OBSERVATION_INGEST_BATCH_CAP)
		return {
			ok: false,
			error: `Batch exceeds ${OBSERVATION_INGEST_BATCH_CAP} events`,
		};
	const result = ingestObservations(asDb(governor), events, now);
	governor.run(
		`DELETE FROM observation_events WHERE rowid NOT IN
		(SELECT rowid FROM observation_events ORDER BY ingest_time DESC LIMIT ?)`,
		OBSERVATION_EVENTS_RETENTION,
	);
	return { ok: true, result, store: observationStoreId(asDb(governor)) };
}

/** The scoped projection query: projectLanes (the lib contract) sorted
 * newest-evidence-first and bounded — totals stay whole-scope. */
export interface ObservationSummary extends LaneSummary {
	/** lanes list cut to the limit; totals still cover the full scope */
	truncated: boolean;
}

export function observationSummary(
	governor: GovernorStore,
	scope: ViewerScope,
	now = Date.now(),
	limit = OBSERVATION_LANES_LIMIT,
): ObservationSummary {
	const view = projectLanes(asDb(governor), scope, now);
	const lanes = [...view.lanes].sort(
		(a, b) => (b.lastSeenSourceTime ?? 0) - (a.lastSeenSourceTime ?? 0),
	);
	const cut = Math.min(Math.max(limit, 1), OBSERVATION_LANES_LIMIT_MAX);
	return {
		...view,
		lanes: lanes.slice(0, cut),
		truncated: lanes.length > cut,
	};
}

/** Bounded SSE push: the scoped snapshot first, then a full re-projection
 * when IN-SCOPE events land — the wake probe is scoped too, so an observes
 * viewer never even learns WHEN foreign projects ingest. Deltas are complete
 * fresh summaries (replay can never gap); a slow client's queue is bounded
 * by a resync + close, and EventSource reconnects + re-snapshots. */
export function observationStream(
	governor: GovernorStore,
	scope: ViewerScope,
): Response {
	const encoder = new TextEncoder();
	let ticks = 0;
	let slowTicks = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	const scopedFlag = scope.projectIds ? 1 : 0;
	const scopedJson = JSON.stringify(scope.projectIds ?? []);
	// in-scope ingest cursor: max rowid in scope (ingest_time is wall clock —
	// two batches in one millisecond would collide; rowid cannot). A retention
	// prune can lower it: that only delays the next wake, never fakes one.
	const scopedWatermark = () =>
		(
			governor
				.query(
					`SELECT COALESCE(MAX(rowid), 0) AS n FROM observation_events
				WHERE (? = 0 OR project_id IN (SELECT value FROM json_each(?)))`,
				)
				.get(scopedFlag, scopedJson) as { n: number }
		).n;
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
				let watermark = scopedWatermark();
				send("snapshot", {
					ok: true,
					...observationSummary(governor, scope),
				});
				timer = setInterval(() => {
					ticks++;
					try {
						if (ticks % STREAM_HEARTBEAT_TICKS === 0) {
							controller.enqueue(encoder.encode(": ping\n\n"));
							return;
						}
						const n = scopedWatermark();
						if (n > watermark) {
							watermark = n;
							if (
								send("delta", {
									ok: true,
									...observationSummary(governor, scope),
								})
							) {
								slowTicks = 0;
								return;
							}
						}
						slowTicks =
							controller.desiredSize !== null && controller.desiredSize <= 0
								? slowTicks + 1
								: 0;
						if (slowTicks >= STREAM_SLOW_CLOSE_TICKS) {
							clearInterval(timer);
							controller.enqueue(
								encoder.encode(`event: resync\ndata: {"ok":true}\n\n`),
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

/** Registered from routes-observations.ts — the host guard and the global
 * write-token guard for POSTs ran in fleet-board.ts before this handler. */
export async function handleObservationPlane(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/api/observation-plane/")) return null;
	if (url.pathname === "/api/observation-plane/ingest") {
		if (req.method !== "POST")
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		const read = await readJsonCapped(req, OBSERVATION_BODY_CAP);
		if (!read.ok) return read.resp;
		const out = ingestBoardObservations(db, read.body);
		return json(
			out.ok
				? { ok: true, store: out.store, ...out.result }
				: { ok: false, error: out.error },
			out.ok ? 200 : 400,
		);
	}
	if (
		url.pathname !== "/api/observation-plane/lanes" &&
		url.pathname !== "/api/observation-plane/stream"
	)
		return null;
	const scope = parseViewerScope(url);
	if (typeof scope === "string") return json({ ok: false, error: scope }, 400);
	if (!viewerAuthorized(req, scope))
		return json(
			{
				ok: false,
				error: "owns/authorized visibility requires the write token",
			},
			403,
		);
	if (url.pathname === "/api/observation-plane/lanes") {
		if (req.method !== "GET" && req.method !== "HEAD")
			return new Response(null, {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			});
		const limit =
			Number(url.searchParams.get("limit")) || OBSERVATION_LANES_LIMIT;
		return json({
			ok: true,
			ts: Date.now(),
			...observationSummary(db, scope, Date.now(), limit),
		});
	}
	if (req.method !== "GET")
		return new Response(null, { status: 405, headers: { Allow: "GET" } });
	return observationStream(db, scope);
}
