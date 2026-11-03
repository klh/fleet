// src/flow-read-model.ts — W2673.1: the gateway flow feed read model. The
// windowed request-edge aggregation behind the AI-Gateway-style live flow
// view (parent W2673): senders (lane/actor) LEFT, the gateway node CENTER
// with req/s, targets (models) RIGHT, and the "needs attention" signals —
// all from the observation projection (request_edges over obs_events) and
// the local ledger's route_audit. Zero new instrumentation: every number
// is a measured row in one of the two windowed scans, never inferred.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { NetworkDbPaths } from "./network-read-model.ts";

/** The offered window lengths (seconds) — the parent's 1/5/10-min selector. */
export const FLOW_WINDOWS_S = [60, 300, 600] as const;
export type FlowWindowS = (typeof FLOW_WINDOWS_S)[number];

const DEFAULT_WINDOW_S: FlowWindowS = 300;
/** Distinct-lane / model rows returned — the columns stay bounded on a
 * busy window; overflow is reported, never silently truncated. */
export const FLOW_ROWS_CAP = 64;
/** Ledger failure signatures kept per target kind (model vs upstream host). */
export const FLOW_FAILURE_CAP = 16;
/** Bounded 30s-bucket series over the window — the req/s sparkline. */
const SERIES_BUCKET_S = 30;
const SERIES_CAP = 40;
/** Error-rate attention threshold: failures/attempts on one target. */
const ERROR_RATE_ALERT = 0.2;
/** Minimum attempts before an error rate becomes signal, not noise. */
const ERROR_RATE_MIN_ATTEMPTS = 5;

export function normalizeFlowWindow(raw: unknown): FlowWindowS {
	const n =
		typeof raw === "string"
			? Number(raw)
			: typeof raw === "number"
				? raw
				: Number.NaN;
	for (const w of FLOW_WINDOWS_S) if (n === w) return w;
	return DEFAULT_WINDOW_S;
}

/** A sender (left column): one fleet lane with its live request counts.
 *  lane === "" renders the unnamed/watchdog-probe bucket honestly. */
export interface FlowSenderRow {
	key: string;
	lane: string;
	actor: string;
	requests: number;
	active: number;
	errors: number;
	lastAt: number;
	/** requests per second over the window (measured count ÷ window). */
	reqPerS: number;
}

/** A target (right column). kind "model" groups the ledger's routed
 *  target_model; kind "upstream" is an unrouted/local relay host row. */
export interface FlowTargetRow {
	key: string;
	kind: "model" | "upstream";
	name: string;
	requests: number;
	errors: number;
	lastAt: string;
	reqPerS: number;
}

export interface FlowAttentionRow {
	kind: "error-spike" | "guardrail-blocks" | "unsettled-climb" | "error-rate";
	/** The subject the card names (model name, lane key, or the hub). */
	subject: string;
	detail: string;
	n: number;
}

export interface FlowSnapshot {
	ok: true;
	schemaVersion: 1;
	ts: string;
	windowS: FlowWindowS;
	windowStart: string;
	gateway: {
		id: string;
		requests: number;
		reqPerS: number;
		active: number;
		errors: number;
		/** 30s buckets oldest→newest, trimmed to the window; null = no
		 *  events at all (never a fabricated flat zero line). */
		series: Array<{ t: number; requests: number }> | null;
	};
	senders: FlowSenderRow[];
	targets: FlowTargetRow[];
	attention: FlowAttentionRow[];
	coverage: {
		projectionAvailable: boolean;
		ledgerAvailable: boolean;
		/** Distinct lanes dropped past the cap (0 = full fidelity). */
		sendersTruncated: number;
		/** Distinct target keys dropped past the cap. */
		targetsTruncated: number;
	};
}

export type FlowResult = FlowSnapshot | { ok: false; reason: string };

interface SenderAgg {
	lane: string;
	actor: string;
	requests: number;
	active: number;
	errors: number;
	lastAt: number;
}

/** Empty-window guard: SUM/COUNT over zero rows stays measured (COUNT=0),
 *  token-free — a 0-request window reports req/s 0 and series [], not
 *  nulls (only an absent DB is "unknown"). */
function seriesBuckets(
	since: number,
	until: number,
): Array<{ t: number; requests: number }> {
	const step = SERIES_BUCKET_S * 1000;
	const out: Array<{ t: number; requests: number }> = [];
	for (let t = since; t < until; t += step) out.push({ t, requests: 0 });
	return out.length > SERIES_CAP ? out.slice(-SERIES_CAP) : out;
}

function reqPerS(count: number, windowS: number): number {
	return Math.round((count / windowS) * 100) / 100;
}

/** The windowed aggregation. The projection db is the primary source
 *  (senders + gateway series + active); the local ledger adds routed
 *  model targets and error detail. Either db missing degrades honestly. */
export function flowSnapshot(
	paths: NetworkDbPaths,
	windowS: FlowWindowS | unknown = DEFAULT_WINDOW_S,
	now: () => number = Date.now,
	hubId = process.env.BUCKLE_HUB_ID ?? "local",
): FlowResult {
	const win = normalizeFlowWindow(windowS);
	const until = now();
	const since = until - win * 1000;

	let senders: FlowSenderRow[] = [];
	let gatewayRequests = 0;
	let gatewayActive = 0;
	let gatewayErrors = 0;
	let projectionAvailable = false;
	let sendersTruncated = 0;
	let series: Array<{ t: number; requests: number }> | null = null;
	let denied = 0;
	let degraded = 0;

	if (paths.obsDb && existsSync(paths.obsDb)) {
		let db: Database | null = null;
		try {
			db = new Database(paths.obsDb, { readonly: true });
			const sinceRows = db
				.query(
					`SELECT lane, actor, COUNT(*) AS requests,
					SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS active,
					SUM(CASE WHEN outcome IN ('errored','denied') THEN 1 ELSE 0 END) AS errors,
					MAX(admitted_at) AS lastAt
					FROM request_edges WHERE admitted_at >= ? AND admitted_at < ?
					GROUP BY lane, actor ORDER BY requests DESC`,
				)
				.all(since, until) as Array<SenderAgg>;
			const total = sinceRows.length;
			sendersTruncated = Math.max(0, total - FLOW_ROWS_CAP);
			senders = sinceRows.slice(0, FLOW_ROWS_CAP).map((r) => ({
				key: r.lane || `actor:${r.actor}`,
				lane: r.lane,
				actor: r.actor,
				requests: r.requests,
				active: r.active ?? 0,
				errors: r.errors ?? 0,
				lastAt: r.lastAt ?? 0,
				reqPerS: reqPerS(r.requests, win),
			}));
			const totals = db
				.query(
					`SELECT COUNT(*) AS requests,
					SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS active,
					SUM(CASE WHEN outcome IN ('errored','denied') THEN 1 ELSE 0 END) AS errors,
					MIN(admitted_at) AS firstAt
					FROM request_edges WHERE admitted_at >= ? AND admitted_at < ?`,
				)
				.get(since, until) as {
				requests: number;
				active: number | null;
				errors: number | null;
				firstAt: number | null;
			};
			gatewayRequests = totals.requests;
			gatewayActive = totals.active ?? 0;
			gatewayErrors = totals.errors ?? 0;
			const buckets = seriesBuckets(since, until);
			if (buckets.length > 0 && totals.requests > 0) {
				const rows = db
					.query(
						`SELECT admitted_at / ${SERIES_BUCKET_S * 1000} AS b, COUNT(*) AS n
						FROM request_edges WHERE admitted_at >= ? AND admitted_at < ?
						GROUP BY b`,
					)
					.all(since, until) as Array<{ b: number; n: number }>;
				const byBucket = new Map(rows.map((r) => [r.b, r.n]));
				for (const bucket of buckets) {
					const n = byBucket.get(
						Math.floor(bucket.t / (SERIES_BUCKET_S * 1000)),
					);
					if (n !== undefined) bucket.requests = n;
				}
				series = buckets;
			} else if (buckets.length > 0) {
				series = [];
			}
			const guardrail = db
				.query(
					`SELECT SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied,
					SUM(CASE WHEN outcome = 'degraded' THEN 1 ELSE 0 END) AS degraded
					FROM request_edges WHERE admitted_at >= ? AND admitted_at < ?`,
				)
				.get(since, until) as {
				denied: number | null;
				degraded: number | null;
			};
			denied = guardrail.denied ?? 0;
			degraded = guardrail.degraded ?? 0;
			projectionAvailable = true;
		} catch {
			// unavailable projection degrades to ledger-only targets
		} finally {
			db?.close();
		}
	}

	let targets: FlowTargetRow[] = [];
	let targetsTruncated = 0;
	let ledgerAvailable = false;
	let unsettled = 0;
	let failures: Array<{
		name: string;
		kind: string;
		n: number;
		lastAt: string;
	}> = [];
	if (existsSync(paths.ledger)) {
		let db: Database | null = null;
		try {
			db = new Database(paths.ledger, { readonly: true });
			const sinceIso = new Date(since).toISOString();
			const untilIso = new Date(until).toISOString();
			const rows = db
				.query(
					`SELECT COALESCE(NULLIF(target_model, ''), target_host, 'unattributed') AS name,
					CASE WHEN target_model IS NULL OR target_model = '' THEN 'upstream' ELSE 'model' END AS kind,
					COUNT(*) AS requests,
					SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
					MAX(ts) AS lastAt
					FROM route_audit WHERE ts >= ? AND ts < ? AND ok IS NOT NULL
					GROUP BY name, kind ORDER BY requests DESC`,
				)
				.all(sinceIso, untilIso) as Array<{
				name: string;
				kind: string;
				requests: number;
				errors: number | null;
				lastAt: string;
			}>;
			targetsTruncated = Math.max(0, rows.length - FLOW_ROWS_CAP);
			targets = rows.slice(0, FLOW_ROWS_CAP).map((r) => ({
				key: `${r.kind}:${r.name}`,
				kind: r.kind === "upstream" ? "upstream" : "model",
				name: r.name,
				requests: r.requests,
				errors: r.errors ?? 0,
				lastAt: r.lastAt,
				reqPerS: reqPerS(r.requests, win),
			}));
			const unsettledRow = db
				.query(
					`SELECT COUNT(*) AS n FROM route_audit
					WHERE ts >= ? AND ts < ? AND ok IS NULL`,
				)
				.get(sinceIso, untilIso) as { n: number };
			unsettled = unsettledRow.n;
			failures = db
				.query(
					`SELECT COALESCE(NULLIF(target_model, ''), target_host, 'unattributed') AS name,
					CASE WHEN target_model IS NULL OR target_model = '' THEN 'upstream' ELSE 'model' END AS kind,
					COUNT(*) AS n, MAX(ts) AS lastAt
					FROM route_audit WHERE ts >= ? AND ts < ? AND ok = 0
					GROUP BY name, kind ORDER BY n DESC LIMIT ${FLOW_FAILURE_CAP}`,
				)
				.all(sinceIso, untilIso) as typeof failures;
			ledgerAvailable = true;
		} catch {
			// unavailable ledger degrades to projection-only senders
		} finally {
			db?.close();
		}
	}

	if (!projectionAvailable && !ledgerAvailable)
		return {
			ok: false,
			reason: "hub observations and local ledger unavailable",
		};

	const attention: FlowAttentionRow[] = [];
	for (const f of failures) {
		const total = targets.find(
			(t) => t.name === f.name && t.kind === f.kind,
		)?.requests;
		if (total !== undefined && total >= ERROR_RATE_MIN_ATTEMPTS) {
			const rate = f.n / total;
			if (rate >= ERROR_RATE_ALERT)
				attention.push({
					kind: "error-rate",
					subject: f.name,
					detail: `${Math.round(rate * 100)}% of ${total} requests on ${f.name} failed in the last ${win / 60 ? Math.round(win / 60) : 1} min`,
					n: f.n,
				});
		}
		attention.push({
			kind: "error-spike",
			subject: f.name,
			detail: `${f.n} failed requests on ${f.name} in the window`,
			n: f.n,
		});
	}
	if (denied > 0)
		attention.push({
			kind: "guardrail-blocks",
			subject: "gateway",
			detail: `${denied} request${denied === 1 ? "" : "s"} blocked at the gateway (outcome denied)`,
			n: denied,
		});
	if (degraded > 0)
		attention.push({
			kind: "guardrail-blocks",
			subject: "gateway",
			detail: `${degraded} request${degraded === 1 ? "" : "s"} masked/degraded by a guardrail`,
			n: degraded,
		});
	if (unsettled > 0)
		attention.push({
			kind: "unsettled-climb",
			subject: "gateway",
			detail: `${unsettled} route_audit rows in the window have no settled outcome (in flight or crashed writer)`,
			n: unsettled,
		});

	return {
		ok: true,
		schemaVersion: 1,
		ts: new Date(until).toISOString(),
		windowS: win,
		windowStart: new Date(since).toISOString(),
		gateway: {
			id: hubId,
			requests: gatewayRequests,
			reqPerS: reqPerS(gatewayRequests, win),
			active: gatewayActive,
			errors: gatewayErrors,
			series,
		},
		senders,
		targets,
		attention,
		coverage: {
			projectionAvailable,
			ledgerAvailable,
			sendersTruncated,
			targetsTruncated,
		},
	};
}
