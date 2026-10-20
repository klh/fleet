// src/network-read-model.ts — W858.10.3: the Network overview read model.
// Per-hub and cloud request state, recent successful routes, token
// throughput, and observation freshness — every number read from buckle's
// own request/usage records (the ledger route_audit/router_usage tables +
// the projection request_edges/obs_events/observer_state tables). Absent
// evidence stays honest: NULL usage columns stay null, rows without an
// outcome stay unsettled, an empty window reports null sums — never
// inferred values or false zeros.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ACTIVE_TTL_MS } from "./projection.ts";

/** One per-hub row: the projection's request_edges grouped by observer
 *  source (each hub/front projects its own stream under its hub id). */
export interface NetworkHubRow {
	source: string;
	lanes: number;
	requests: number;
	errors: number;
	/** Requested but never ended — the projection's reconciled active
	 *  (ended_at IS NULL after crash/quiet reconciliation to 'unknown'). */
	active: number;
	lastAt: number;
	/** Observation freshness for this source: null = never observed. */
	freshness: {
		lastEventAt: number | null;
		lastSeq: number | null;
		ageS: number | null;
	};
}

export interface NetworkRouteRow {
	ts: string;
	lane: string;
	actor: string;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
	status: number | null;
	duration_ms: number | null;
	/** Provider-reported tokens; null = the response carried no usage. */
	in_tok: number | null;
	out_tok: number | null;
}

export interface NetworkThroughput {
	/** Recorded hour buckets, newest first — only buckets with rows. */
	buckets: Array<{
		hour: string;
		in_tok: number;
		out_tok: number;
		requests: number;
	}>;
	/** Settled-token flow over a recent window; sums stay null when no
	 *  settled usage rows fall in the window (never a fabricated 0). */
	window: {
		sinceIso: string;
		requests: number;
		in_tok: number | null;
		out_tok: number | null;
	};
	/** Per-interface (target kind/host/model) trailing-window rows — the
	 *  measured hub→interface edges. Present only when route provenance
	 *  exists; an interface with no settled traffic is absent, not zero. */
	interfaces: NetworkInterfaceRow[];
}

/** Buckle ledger outcomes in the trailing window. A failed local relay is
 * never assigned to the cloud service behind that relay. */
export interface NetworkAuditWindow {
	sinceIso: string;
	attempts: number;
	succeeded: number;
	failed: number;
	unsettled: number;
	unattributedFailed: number;
	failures: Array<{
		kind: string | null;
		host: string | null;
		port: number | null;
		count: number;
		lastAt: string;
	}>;
}

/** One measured hub→interface edge over the trailing windows: rate window
 *  (short, feeds tok/s) + workload window (long, feeds counts). Token sums
 *  are null when the window has no usage-bearing settled rows. */
export interface NetworkInterfaceRow {
	kind: string;
	host: string | null;
	port: number | null;
	model: string | null;
	/** Rate window (60s) measured sums; null = no settled usage in window. */
	in60: number | null;
	out60: number | null;
	req60: number;
	/** Workload window (15m) measured sums; null = no settled usage. */
	in15: number | null;
	out15: number | null;
	req15: number;
	/** Newest settled ts for this interface — provenance recency. */
	lastOkAt: string | null;
}

/** One observed hub↔hub forwarding edge in the workload window, from the
 *  projection's request_edges origin/peer columns. Absent pair = never
 *  observed here, never inferred. */
export interface HopRow {
	origin: string;
	peer: string | null;
	source: string;
	n: number;
	lastAt: number;
}

/** ok:false variants carry the reason; the panel hides honestly. */
export type NetworkOverviewResult =
	| {
			ok: true;
			ts: string;
			/** Ledger recency: MAX(route_audit.ts) — null = empty ledger. */
			lastAuditAt: string | null;
			hubs: NetworkHubRow[];
			/** Decision rows without an outcome, by target_kind — in flight
			 *  or a crashed writer; never counted as settled either way. */
			unsettled: Array<{ kind: string; n: number }>;
			audit15: NetworkAuditWindow;
			routes: NetworkRouteRow[];
			/** Observed hub↔hub forwarding edges (request_edges origin/peer)
			 *  in the workload window — present only where observed. */
			hops: HopRow[];
			throughput: NetworkThroughput;
			observations: {
				path: string | null;
				available: boolean;
				/** Fleet-wide MAX(obs_events.time) — null = no events yet. */
				lastEventAt: string | null;
			};
	  }
	| { ok: false; reason: string };

export const NETWORK_ROUTES_CAP = 12;
export const NETWORK_BUCKETS_CAP = 24;
export const NETWORK_WINDOW_MIN = 15;

export interface NetworkDbPaths {
	ledger: string;
	/** The projection db (optional section — the overview degrades without
	 *  it, keeping the ledger-only sections). */
	obsDb?: string | null;
}

/** Config-over-code path resolution — env knobs first, machine defaults
 *  second (the model-store BUCKLE_DB precedent; the board and /console/buckle
 *  reuse this so /api/lane-routes stops 404ing on an unset knob). */
export function resolveNetworkDbPaths(
	env: Record<string, string | undefined>,
): NetworkDbPaths {
	const home = env.HOME ?? "";
	const ledger =
		env.BUCKLE_DB ??
		(home ? `${home}/.claude/local-llm/buckle.db` : "buckle.db");
	const obsDb =
		env.KLH_LANE_ROUTES_DB ??
		env.BUCKLE_OBSERVATIONS_DB ??
		(env.BUCKLE_OBSERVATIONS_PATH
			? `${env.BUCKLE_OBSERVATIONS_PATH}.db`
			: null) ??
		(home ? `${home}/.claude/local-llm/buckle-obs.db` : null);
	return { ledger, obsDb };
}

/** The overview over both dbs. Ledger unavailable (missing file / open
 *  failure) = ok:false. A missing projection db degrades the hubs +
 *  observations freshness, not the whole payload. */
export function networkOverview(
	paths: NetworkDbPaths,
	now: () => number = Date.now,
): NetworkOverviewResult {
	if (!existsSync(paths.ledger))
		return { ok: false, reason: `ledger db not found: ${paths.ledger}` };
	let db: Database;
	try {
		db = new Database(paths.ledger, { readonly: true });
	} catch (error) {
		return { ok: false, reason: `ledger db unavailable: ${String(error)}` };
	}
	try {
		const t = now();
		return {
			ok: true,
			ts: new Date(t).toISOString(),
			lastAuditAt: ledgerLastAuditAt(db),
			hubs: paths.obsDb ? hubRows(paths.obsDb, t) : [],
			unsettled: unsettledByKind(db),
			audit15: auditWindow(db, t),
			routes: recentRoutes(db),
			throughput: {
				buckets: usageBuckets(db, t),
				window: tokenWindow(db, t),
				interfaces: interfaceRows(db, t),
			},
			hops: paths.obsDb ? hubHops(paths.obsDb, t) : [],
			observations: observationsSection(paths.obsDb, t),
		};
	} finally {
		db.close();
	}
}

function ledgerLastAuditAt(db: Database): string | null {
	return (
		(
			db.query("SELECT MAX(ts) AS m FROM route_audit").get() as {
				m: string | null;
			}
		)?.m ?? null
	);
}

function auditWindow(db: Database, now: number): NetworkAuditWindow {
	const sinceIso = new Date(now - NETWORK_WINDOW_MIN * 60_000).toISOString();
	const row = db
		.query(`SELECT COUNT(*) AS attempts,
		COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS succeeded,
		COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
		COALESCE(SUM(CASE WHEN ok IS NULL THEN 1 ELSE 0 END), 0) AS unsettled,
		COALESCE(SUM(CASE WHEN ok = 0 AND (target_kind IS NULL OR target_host IS NULL)
			THEN 1 ELSE 0 END), 0) AS unattributedFailed
		FROM route_audit WHERE ts >= ?`)
		.get(sinceIso) as Pick<
		NetworkAuditWindow,
		"attempts" | "succeeded" | "failed" | "unsettled" | "unattributedFailed"
	>;
	const failures = db
		.query(`SELECT target_kind AS kind, target_host AS host,
		target_port AS port, COUNT(*) AS count, MAX(ts) AS lastAt
		FROM route_audit WHERE ts >= ? AND ok = 0
		GROUP BY target_kind, target_host, target_port
		ORDER BY count DESC, lastAt DESC`)
		.all(sinceIso) as NetworkAuditWindow["failures"];
	return {
		sinceIso,
		attempts: row.attempts,
		succeeded: row.succeeded,
		failed: row.failed,
		unsettled: row.unsettled,
		unattributedFailed: row.unattributedFailed,
		failures,
	};
}

function unsettledByKind(db: Database): Array<{ kind: string; n: number }> {
	return (
		db
			.query(
				`SELECT target_kind AS kind, COUNT(*) AS n FROM route_audit
			WHERE status IS NULL AND target_kind IS NOT NULL
			GROUP BY target_kind ORDER BY n DESC`,
			)
			.all() as Array<{ kind: string; n: number }>
	).map((r) => ({ kind: r.kind ?? "", n: r.n }));
}

function recentRoutes(db: Database): NetworkRouteRow[] {
	return db
		.query(
			`SELECT ts, lane, actor, target_kind, target_host, target_port,
		target_model, status, duration_ms, in_tok, out_tok
		FROM route_audit WHERE ok = 1
		ORDER BY ts DESC, rid DESC LIMIT ${NETWORK_ROUTES_CAP}`,
		)
		.all() as NetworkRouteRow[];
}

/** Per-interface trailing-window rows: GROUP BY the route's measured
 *  target — the hub→interface edges with their provenance recency. */
function interfaceRows(db: Database, t: number): NetworkInterfaceRow[] {
	const since15 = new Date(t - NETWORK_WINDOW_MIN * 60_000).toISOString();
	const since60 = new Date(t - 60_000).toISOString();
	return db
		.query(
			`SELECT target_kind AS kind, target_host AS host,
		target_port AS port, target_model AS model,
		SUM(CASE WHEN ts >= ? THEN in_tok ELSE NULL END) AS in60,
		SUM(CASE WHEN ts >= ? THEN out_tok ELSE NULL END) AS out60,
		SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS req60,
		SUM(in_tok) AS in15, SUM(out_tok) AS out15,
		COUNT(*) AS req15, MAX(ts) AS lastOkAt
		FROM route_audit
		WHERE ok = 1 AND ts >= ? AND target_kind IS NOT NULL
		GROUP BY target_kind, target_host, target_port, target_model
		ORDER BY out15 DESC`,
		)
		.all(
			since60,
			since60,
			since60,
			since15,
		) as unknown as NetworkInterfaceRow[];
}

function usageBuckets(db: Database, now: number): NetworkThroughput["buckets"] {
	const end = Math.floor(now / 3_600_000) * 3_600_000;
	const start = end - (NETWORK_BUCKETS_CAP - 1) * 3_600_000;
	const hour = (time: number): string =>
		`${new Date(time).toISOString().slice(0, 13)}:00`;
	const rows = db
		.query(
			`SELECT hour_bucket AS hour, SUM(in_tok) AS in_tok,
			SUM(out_tok) AS out_tok, SUM(requests) AS requests
			FROM router_usage WHERE hour_bucket BETWEEN ? AND ?
			GROUP BY hour_bucket ORDER BY hour_bucket DESC`,
		)
		.all(hour(start), hour(end)) as NetworkThroughput["buckets"];
	const byHour = new Map(rows.map((row) => [row.hour, row]));
	return Array.from({ length: NETWORK_BUCKETS_CAP }, (_, i) => {
		const key = hour(end - i * 3_600_000);
		return byHour.get(key) ?? { hour: key, in_tok: 0, out_tok: 0, requests: 0 };
	});
}

/** Settled-token flow over the trailing window (route_audit rows with
 *  provider-reported usage). SUM over no rows is SQL NULL — kept null;
 *  COUNT is a true measured 0. */
function tokenWindow(db: Database, t: number): NetworkThroughput["window"] {
	const sinceIso = new Date(t - NETWORK_WINDOW_MIN * 60_000).toISOString();
	const row = db
		.query(
			`SELECT COUNT(*) AS requests, SUM(in_tok) AS in_tok,
		SUM(out_tok) AS out_tok FROM route_audit
		WHERE ok = 1 AND in_tok IS NOT NULL AND ts >= ?`,
		)
		.get(sinceIso) as {
		requests: number;
		in_tok: number | null;
		out_tok: number | null;
	};
	return {
		sinceIso,
		requests: row?.requests ?? 0,
		in_tok: row?.in_tok ?? null,
		out_tok: row?.out_tok ?? null,
	};
}

interface RawHubGroup {
	source: string;
	lanes: number;
	requests: number;
	errors: number | null;
	active: number | null;
	lastAt: number | null;
}

function hubGroups(db: Database, now: number): RawHubGroup[] {
	return db
		.query(
			`SELECT source, COUNT(DISTINCT lane) AS lanes, COUNT(*) AS requests,
		SUM(CASE WHEN outcome IN ('errored','denied') THEN 1 ELSE 0 END) AS errors,
		SUM(CASE WHEN ended_at IS NULL AND admitted_at >= ? THEN 1 ELSE 0 END) AS active,
		MAX(admitted_at) AS lastAt
		FROM request_edges GROUP BY source ORDER BY lastAt DESC LIMIT 64`,
		)
		.all(now - ACTIVE_TTL_MS) as RawHubGroup[];
}

function freshnessMaps(db: Database): {
	lastEvents: Map<string, string | null>;
	seqs: Map<string, number>;
} {
	const lastEvents = new Map(
		(
			db
				.query(
					"SELECT source, MAX(time) AS iso FROM obs_events GROUP BY source",
				)
				.all() as Array<{ source: string; iso: string | null }>
		).map((r) => [r.source, r.iso]),
	);
	const seqs = new Map(
		(
			db.query("SELECT source, last_seq FROM observer_state").all() as Array<{
				source: string;
				last_seq: number;
			}>
		).map((r) => [r.source, r.last_seq]),
	);
	return { lastEvents, seqs };
}

function mergeFreshness(
	g: RawHubGroup,
	lastEvents: Map<string, string | null>,
	seqs: Map<string, number>,
	now: number,
): NetworkHubRow {
	const iso = lastEvents.get(g.source) ?? null;
	const lastEventAt = iso ? Date.parse(iso) || null : null;
	const lastSeq = seqs.get(g.source) ?? null;
	return {
		source: g.source,
		lanes: g.lanes,
		requests: g.requests,
		errors: g.errors ?? 0,
		active: g.active ?? 0,
		lastAt: g.lastAt ?? 0,
		freshness: {
			lastEventAt,
			lastSeq,
			ageS: lastEventAt
				? Math.max(0, Math.round((now - lastEventAt) / 1000))
				: null,
		},
	};
}

/** Thin orchestrator: open the projection db readonly, project the hub
 *  rows + freshness, degrade to empty on any read failure. */
function hubRows(obsDb: string, now: number): NetworkHubRow[] {
	if (!existsSync(obsDb)) return [];
	let db: Database | null = null;
	try {
		db = new Database(obsDb, { readonly: true });
		const { lastEvents, seqs } = freshnessMaps(db);
		return hubGroups(db, now).map((g) =>
			mergeFreshness(g, lastEvents, seqs, now),
		);
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

/** Observed hub↔hub forwarding edges (request_edges origin/peer pairs)
 *  within the workload window — only pairs the projection recorded. */
function hubHops(obsDb: string, t: number): HopRow[] {
	if (!existsSync(obsDb)) return [];
	let db: Database | null = null;
	try {
		db = new Database(obsDb, { readonly: true });
		const since15 = new Date(t - NETWORK_WINDOW_MIN * 60_000).getTime();
		return db
			.query(
				`SELECT origin, peer, source, COUNT(*) AS n,
			MAX(admitted_at) AS lastAt
			FROM request_edges WHERE admitted_at >= ? AND peer IS NOT NULL
			GROUP BY origin, peer, source ORDER BY n DESC LIMIT 64`,
			)
			.all(since15) as HopRow[];
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

function observationsSection(
	obsDb: string | null | undefined,
	_t: number,
): {
	path: string | null;
	available: boolean;
	lastEventAt: string | null;
} {
	if (!obsDb || !existsSync(obsDb))
		return { path: obsDb ?? null, available: false, lastEventAt: null };
	let db: Database | null = null;
	try {
		db = new Database(obsDb, { readonly: true });
		const row = db.query("SELECT MAX(time) AS iso FROM obs_events").get() as {
			iso: string | null;
		} | null;
		return {
			path: obsDb,
			available: true,
			lastEventAt: row?.iso ?? null,
		};
	} catch {
		return { path: obsDb, available: false, lastEventAt: null };
	} finally {
		db?.close();
	}
}
