// src/gov/inflight.ts — W1259 exact in-flight request index: every request
// this gateway process handles, from ingress to settle, as ONE queryable
// row. Per-row: account (key id — never key material), model, upstream,
// gateway hop (origin/peer hub ids), trace id, start time and state, plus
// aggregate counts. Correlation across hops rides the W3C trace id (the
// only trace header that leaves the trust boundary, wire.ts) + the W706
// baggage hub ids; a relaying hub forwards the same trace id, so spoke →
// hub rows join on `trace_id`, and the litellm leg receives the same
// traceparent header for a log-side join. Bounded by construction: active
// entries cap + evict-oldest, the settled ring caps by count AND age — the
// index can never grow with traffic. Direct-to-provider traffic (e.g.
// direct Z.ai calls that skip every gateway) never touches this process
// and is reported as unobservable — labeling it here would be a lie.
//
// Layering: the registry reads the proxy Ctx STRUCTURALLY (InflightSource /
// InflightDispatchSource) and never imports handlers.ts — the dependency
// points one way, handlers → here. W1118 owns server.ts/middleware.ts/
// slots.ts; this module touches none of their surfaces (process-global
// module state, the drain.ts precedent).

/** Exactness law (owner note #67628): a still-open request NEVER leaves
 *  the active set — no evict-oldest, no age-based staleness (a legitimate
 *  held connection must not be mislabeled). Rows settle ONLY on the real
 *  close/abort; the active set is bounded by the gate own admission
 *  caps (W450 RPC admission + W468 slots), which refuse past their
 *  ceilings rather than queue blindly.
 */

/** Bounded retention: the settled ring keeps at most this many rows … */
const MAX_RECENT = 512;
/** … and never a row older than this (swept on write and read). */
const RECENT_TTL_MS = 5 * 60_000;

/** The unobservable face: direct-to-provider traffic bypasses every
 *  gateway hop this index can see. */
export const EXTERNAL_UNOBSERVABLE_NOTE =
	"direct client-to-provider traffic (e.g. direct Z.ai calls) bypasses every gateway hop and is unobservable here; it needs provider-side account telemetry";

/** Account identification uses the key ID only — raw key material never
 *  enters this module, so it can never leak through the index. */
export interface InflightSource {
	rid: string;
	trace: { traceparent: string };
	/** Key id (or "root") — an identifier, never the credential itself. */
	key: string;
	lane: string;
	dialect: string;
	hop: { origin: string; peer: string | null };
	trafficKind: string;
}

/** The dispatch face: the selection as the audit path sees it (structural
 *  subset of RouteSelection's head). */
export interface InflightDispatchSource {
	rid: string;
	model: string;
	sel?: {
		head: {
			candidate_id: string;
			kind: string;
			host: string;
			port: number;
			model: string;
		};
	} | null;
}

export type InflightState =
	| "queued"
	| "held"
	| "streaming"
	| "settled"
	| "denied";

interface Entry {
	rid: string;
	traceId: string;
	account: string;
	lane: string;
	dialect: string;
	origin: string;
	peer: string | null;
	trafficKind: string;
	model: string;
	upstream: {
		candidate_id: string;
		kind: string;
		host: string;
		port: number;
		model: string;
	} | null;
	state: InflightState;
	startMs: number;
	endMs: number | null;
	status: number | null;
	ok: boolean | null;
	decision: string | null;
	refusal: string | null;
}

/** The row shape served by GET /v1/admin/inflight (snake_case per the
 *  admin API convention). */
export interface InflightRow {
	rid: string;
	trace_id: string;
	account: string;
	lane: string;
	dialect: string;
	model: string;
	upstream: {
		candidate_id: string;
		kind: string;
		host: string;
		port: number;
		model: string;
	} | null;
	hop: { origin: string; peer: string | null; kind: "origin" | "forwarded" };
	state: InflightState;
	traffic_kind: string;
	start_ms: number;
	duration_ms: number;
	end_ms: number | null;
	status: number | null;
	ok: boolean | null;
	decision: string | null;
	refusal: string | null;
}

export interface InflightIndex {
	requests: InflightRow[];
	tunnels: InflightTunnelRow[];
	recent: InflightRow[];
	aggregates: {
		active: number;
		active_requests: number;
		active_tunnels: number;
		by_state: Record<string, number>;
		by_model: Record<string, number>;
		by_upstream: Record<string, number>;
		by_account: Record<string, number>;
		by_lane: Record<string, number>;
		by_hop: Record<string, number>;
		by_dest: Record<string, number>;
		recent_completed: number;
	};
	limits: {
		max_recent: number;
		recent_ttl_ms: number;
	};
	correlation: {
		join_key: "trace_id";
		hop_ids: string;
		note: string;
	};
	external: { observable: false; note: string };
}

/** One held tunnel as W1260.2 connect-egress reports it (their
 *  snapshot() shape — I ingest verbatim, they stay import-only). */
export interface ConnectTunnelHeld {
	id: string;
	host: string;
	port: number | null;
	app: string;
	openedAt: number;
	bytesUp: number | null;
	bytesDown: number | null;
	state: string;
}

/** W1260.2 connect-egress snapshot() face: the whole held set. */
export interface ConnectSnapshot {
	held: ConnectTunnelHeld[];
	count: number;
}

/** The served tunnel row (GET /v1/admin/inflight tunnels[]). */
export interface InflightTunnelRow {
	id: string;
	host: string;
	port: number | null;
	app: string;
	age_ms: number;
	bytes_up: number | null;
	bytes_down: number | null;
}

// ─── process-global state (the drain.ts precedent) ──────────────────────────

const active = new Map<string, Entry>();
const recent: Entry[] = [];
/** CONNECT tunnel records (W1260.2 seam): keyed by tunnel id, exact while
 *  open, dropped at close — no age guessing here either. */
const tunnels = new Map<string, ConnectTunnelHeld>();

/** Injected clock (test seam); defaults to the wall clock. */
let now = (): number => Date.now();

/** Row projection shared by both lists. */
function rowOf(e: Entry, atMs: number): InflightRow {
	return {
		rid: e.rid,
		trace_id: e.traceId,
		account: e.account,
		lane: e.lane,
		dialect: e.dialect,
		model: e.model,
		upstream: e.upstream === null ? null : { ...e.upstream },
		hop: {
			origin: e.origin,
			peer: e.peer,
			kind: e.peer === null ? "origin" : "forwarded",
		},
		state: e.state,
		traffic_kind: e.trafficKind,
		start_ms: e.startMs,
		duration_ms: Math.max(0, (e.endMs ?? atMs) - e.startMs),
		end_ms: e.endMs,
		status: e.status,
		ok: e.ok,
		decision: e.decision,
		refusal: e.refusal,
	};
}

/** TTL + cap sweep for the recent ring; called on write and read. */
function sweepRecent(atMs: number): void {
	const floor = atMs - RECENT_TTL_MS;
	while (recent.length > 0 && (recent[0]?.endMs ?? 0) < floor) recent.shift();
	while (recent.length > MAX_RECENT) recent.shift();
}

/** W1259 stream start: the response body is flowing to the client. The
 *  row stays "streaming" until the stream finish seam fires the real
 *  settle (EOF, cancel, failure or drain cut). */
export function holdInflightStream(rid: string): void {
	const e = active.get(rid);
	if (e === undefined) return;
	if (e.state === "queued" || e.state === "held") e.state = "streaming";
}

/** W1259 ingress hook: register the request the moment the proxy context
 *  exists (before body read/routing — refusals settle through the same end
 *  hook). NO eviction: every admitted request stays active until its real
 *  settle (owner note #67628) — the row that vanishes is the row that lies. */
export function beginInflight(src: InflightSource): void {
	sweepRecent(now());
	active.set(src.rid, newEntry(src, now()));
}

/** The fresh entry for a new rid (kept out of beginInflight for size). */
function newEntry(src: InflightSource, t: number): Entry {
	return {
		rid: src.rid,
		traceId: src.trace.traceparent.split("-")[1] ?? "",
		account: src.key,
		lane: src.lane,
		dialect: src.dialect,
		origin: src.hop.origin,
		peer: src.hop.peer,
		trafficKind: src.trafficKind,
		model: "",
		upstream: null,
		state: "queued",
		startMs: t,
		endMs: null,
		status: null,
		ok: null,
		decision: null,
		refusal: null,
	};
}

/** W1259 dispatch hook: the routing decision landed — record model +
 *  selected upstream so a long generation shows its target WHILE streaming,
 *  not only after settle. */
export function markInflight(src: InflightDispatchSource): void {
	const e = active.get(src.rid);
	if (e === undefined) return;
	e.model = src.model;
	if (src.sel !== undefined && src.sel !== null) {
		const h = src.sel.head;
		e.upstream = {
			candidate_id: h.candidate_id,
			kind: h.kind,
			host: h.host,
			port: h.port,
			model: h.model,
		};
	}
	if (e.state === "queued") e.state = "held";
}

/** W1259 settle hook: every proxy response crosses the stamped() seam —
 *  success, refusal and denial alike — so this is the ONE end of life. */
export function endInflight(
	rid: string,
	status: number,
	ok: boolean,
	decision: string | null,
	refusal: string | null,
): void {
	const e = active.get(rid);
	if (e === undefined) return;
	active.delete(rid);
	const t = now();
	e.endMs = t;
	e.status = status;
	e.ok = ok;
	e.decision = decision;
	e.refusal = refusal;
	e.state = ok ? "settled" : "denied";
	recent.push(e);
	sweepRecent(t);
}

/** Settle face for the shared response seam: streaming responses HOLD
 *  (state streaming) until their stream finish seam fires the real
 *  settle; every other response ends here. The route is read
 *  structurally (stamped() options — decision, refusal, streaming). */
export interface SettleRoute {
	decision: string;
	refusal?: string;
	streaming?: boolean;
}

export function settleInflight(
	ctxLike: { rid: string },
	respLike: { status: number; ok: boolean },
	route: SettleRoute,
): void {
	if (route.streaming === true) holdInflightStream(ctxLike.rid);
	else
		endInflight(
			ctxLike.rid,
			respLike.status,
			respLike.ok,
			route.decision ?? null,
			route.refusal ?? null,
		);
}

/** W1259 admin read: the exact index — active rows (newest start first),
 *  the bounded settled ring (newest end first) and aggregate counts. */
export function inflightIndex(): InflightIndex {
	const t = now();
	sweepRecent(t);
	const requests: InflightRow[] = [];
	const recentRows: InflightRow[] = [];
	const byState: Record<string, number> = {};
	const byModel: Record<string, number> = {};
	const byUpstream: Record<string, number> = {};
	const byAccount: Record<string, number> = {};
	const byLane: Record<string, number> = {};
	const byHop: Record<string, number> = {};
	const byDest: Record<string, number> = {};
	const bump = (m: Record<string, number>, k: string): void => {
		m[k] = (m[k] ?? 0) + 1;
	};
	for (const e of active.values()) {
		requests.push(rowOf(e, t));
		bump(byState, e.state);
		bump(byModel, e.model === "" ? "unknown" : e.model);
		bump(
			byUpstream,
			e.upstream === null ? "unselected" : e.upstream.candidate_id,
		);
		bump(byAccount, e.account);
		bump(byLane, e.lane === "" ? "(direct)" : e.lane);
		bump(byHop, e.peer === null ? "origin" : "forwarded");
	}
	for (let i = recent.length - 1; i >= 0; i--) {
		const e = recent[i];
		if (e === undefined) continue;
		recentRows.push(rowOf(e, t));
	}
	requests.sort((a, b) => b.start_ms - a.start_ms);
	const tunnelRows: InflightTunnelRow[] = [...tunnels.values()].map((h) => ({
		id: h.id,
		host: h.host,
		port: h.port,
		app: h.app,
		age_ms: Math.max(0, t - h.openedAt),
		bytes_up: h.bytesUp,
		bytes_down: h.bytesDown,
	}));
	tunnelRows.sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const h of tunnels.values()) {
		bump(byDest, h.port === null ? h.host : `${h.host}:${h.port}`);
	}
	return {
		requests,
		tunnels: tunnelRows,
		recent: recentRows,
		aggregates: {
			active: requests.length + tunnels.size,
			active_requests: requests.length,
			active_tunnels: tunnels.size,
			by_state: byState,
			by_model: byModel,
			by_upstream: byUpstream,
			by_account: byAccount,
			by_lane: byLane,
			by_hop: byHop,
			recent_completed: recentRows.length,
			by_dest: byDest,
		},
		limits: { max_recent: MAX_RECENT, recent_ttl_ms: RECENT_TTL_MS },
		correlation: {
			join_key: "trace_id",
			hop_ids: "baggage fleet.origin.hub.id / fleet.peer.hub.id",
			note: "spoke/hub rows share the trace id; the litellm leg receives the same traceparent header for a log-side join",
		},
		external: { observable: false, note: EXTERNAL_UNOBSERVABLE_NOTE },
	};
}

/** Test seam: module-global state, the resetDrainForTest precedent. */
export function resetInflightForTest(): void {
	active.clear();
	recent.length = 0;
	now = (): number => Date.now();
}

/** Test seam: drive the clock for TTL/staleness/eviction assertions. */
export function setInflightClockForTest(fn: () => number): void {
	now = fn;
}

/** W1260.2 seam: ingest a connect-egress snapshot VERBATIM — open tunnels
 *  replace by id (exact while open), closed ids drop. The record is
 *  consumed, never mutated, and the projection computes age live. */
export function acceptConnectSnapshot(snap: ConnectSnapshot): void {
	for (const h of snap.held) tunnels.set(h.id, h);
	const live = new Set(snap.held.map((h) => h.id));
	for (const id of [...tunnels.keys()]) if (!live.has(id)) tunnels.delete(id);
}

/** Test seam: clear tunnel rows too (module-global reset). */
export function clearTunnelsForTest(): void {
	tunnels.clear();
}
