// hooks/lib/fleet-loop/monitor-drill.ts — W995: the usage page's drilldown monitor.
// Groups the buckle request ledger (cache-drill's shared hub row collection)
// by model | provider | hub | lane and computes throughput, cache, failure
// and latency aggregates per group, plus uPlot-ready hourly series for the
// top groups. Work type rides the W243 activity meter, keyed by lane/actor —
// supplied by the route, so this module stays a pure function of its rows.
// Every metric carries its coverage: unknown stays unknown, never zero.
import {
	cacheKnown,
	collectHubRows,
	isProbeRow,
	type BuckleRequestRow,
	type DrillOpts,
	type HubDrillStatus,
} from "../usage/cache-drill.ts";

export const MONITOR_DIMS = ["model", "provider", "hub", "lane"] as const;
export type MonitorDim = (typeof MONITOR_DIMS)[number];

export const MONITOR_METRICS = [
	"requests",
	"throughput",
	"failures",
	"cache",
	"latency",
] as const;
export type MonitorMetric = (typeof MONITOR_METRICS)[number];

/** Series ceiling — the chart carries the busiest groups only. */
export const MONITOR_TOP_N = 8;

/** W243 work-type join slice (per lane/actor): orientation-vs-implementation
 *  share, context share of requests, searches per request. */
export interface LaneWork {
	orient: number;
	context: number;
	spr: number;
}

export interface MonitorRow {
	key: string;
	requests: number;
	// throughput: provider-reported output tokens over the window
	out_tok: number;
	/** rows whose in/out tokens the provider actually reported. */
	tok_reported: number;
	// failures: ok === false or status >= 400
	failures: number;
	/** rows with a failure verdict at all (ok set or status set). */
	failure_observed: number;
	// cache
	known: number;
	warm: number;
	warm_ratio: number;
	cache_r_tok: number;
	// latency (ms, provider-reported duration)
	lat_known: number;
	lat_p50_ms: number | null;
	lat_p95_ms: number | null;
	lat_avg_ms: number | null;
	// work type — lanes only, honest null when the meter has no such lane
	work: LaneWork | null;
}

/** Columnar uPlot series: [x, top1..topN] per metric, x in unix SECONDS. */
export interface MonitorSeriesSet {
	x: number[];
	labels: string[];
	requests: number[][];
	throughput: number[][];
	failures: number[][];
	cache: number[][];
	latency: number[][];
}

export interface MonitorCoverage {
	requests: number;
	/** readiness-probe synthetics — excluded from every aggregate, counted. */
	probe_requests: number;
	rows_with_tokens: number;
	rows_with_duration: number;
	rows_with_cache_verdict: number;
	rows_with_failure_verdict: number;
	/** raw rows per hub before the per-hub ceiling — 0 = untruncated. */
	per_hub_row_limit: number;
}

/** transcript-side meter slice, supplied by the board route. */
export interface TranscriptMeter {
	source: string;
	requests: number;
	cache_read_tokens: number;
}

export interface MonitorReport {
	ok: true;
	ts: string;
	days: number;
	dim: MonitorDim;
	hubs: HubDrillStatus[];
	/** grouped rows, busiest first, capped at 200 for the wire. */
	rows: MonitorRow[];
	series: MonitorSeriesSet | null;
	coverage: MonitorCoverage;
	/** transcript-side meter, supplied by the board route. */
	transcripts?: TranscriptMeter;
}

const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

/** The grouping key for one row under one dimension. */
export function monitorKey(dim: MonitorDim, r: BuckleRequestRow): string {
	switch (dim) {
		case "model":
			return r.target_model ?? "(unrouted)";
		case "provider":
			if (r.target_host === null) return "(unrouted)";
			return r.target_port === null
				? r.target_host
				: `${r.target_host}:${String(r.target_port)}`;
		case "hub":
			return r.hub ?? "(unlisted)";
		case "lane":
			return r.lane === "" ? "(bare ingress)" : r.lane;
	}
}

const failed = (r: BuckleRequestRow): boolean =>
	r.ok === false || (r.status !== null && r.status >= 400);

const emptyRow = (key: string): MonitorRow => ({
	key,
	requests: 0,
	out_tok: 0,
	tok_reported: 0,
	failures: 0,
	failure_observed: 0,
	known: 0,
	warm: 0,
	warm_ratio: 0,
	cache_r_tok: 0,
	lat_known: 0,
	lat_p50_ms: null,
	lat_p95_ms: null,
	lat_avg_ms: null,
	work: null,
});

/** Group inference rows by dimension and aggregate every metric. Probes are
 *  excluded (the coverage counts them separately, W921 discipline). */
export function monitorAggregates(
	rows: BuckleRequestRow[],
	dim: MonitorDim,
	work?: Record<string, LaneWork>,
): MonitorRow[] {
	const groups = new Map<string, MonitorRow & { durs: number[] }>();
	for (const r of rows) {
		if (isProbeRow(r)) continue;
		const key = monitorKey(dim, r);
		const cur = groups.get(key) ?? { ...emptyRow(key), durs: [] };
		cur.requests += 1;
		if (r.in_tok !== null || r.out_tok !== null) {
			cur.tok_reported += 1;
			cur.out_tok += num(r.out_tok);
		}
		if (r.ok !== null || r.status !== null) {
			cur.failure_observed += 1;
			if (failed(r)) cur.failures += 1;
		}
		if (cacheKnown(r)) {
			cur.known += 1;
			if ((r.cache_r ?? 0) > 0) cur.warm += 1;
		}
		cur.cache_r_tok += num(r.cache_r);
		if (r.duration_ms !== null) {
			cur.lat_known += 1;
			cur.durs.push(r.duration_ms);
		}
		groups.set(key, cur);
	}
	return [...groups.values()]
		.map(({ durs, ...row }) => {
			if (durs.length > 0) {
				const s = [...durs].sort((a, b) => a - b);
				// nearest-rank: p95 of 10 samples is the 10th, not the 9th
				const pick = (p: number): number =>
					s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0;
				row.lat_p50_ms = pick(0.5);
				row.lat_p95_ms = pick(0.95);
				row.lat_avg_ms = Math.round(
					durs.reduce((a, d) => a + d, 0) / durs.length,
				);
			}
			row.warm_ratio = row.known > 0 ? row.warm / row.known : 0;
			row.work = dim === "lane" ? (work?.[row.key] ?? null) : null;
			return row;
		})
		.sort((a, b) => b.requests - a.requests);
}

/** Hourly series for the top MONITOR_TOP_N groups: requests, out tok,
 *  failures, warm hits, avg latency ms per hour bucket. Zeros filled. */
export function monitorSeries(
	rows: BuckleRequestRow[],
	dim: MonitorDim,
	days: number,
	nowMs: number,
): MonitorSeriesSet | null {
	const top = monitorAggregates(rows, dim)
		.slice(0, MONITOR_TOP_N)
		.map((r) => r.key);
	if (top.length === 0) return null;
	const hour = 3_600_000;
	const from = Math.floor((nowMs - days * 86_400_000) / hour) * hour;
	const to = Math.floor(nowMs / hour) * hour;
	const x: number[] = [];
	for (let b = from; b <= to; b += hour) x.push(Math.round(b / 1000));
	const idx = new Map(top.map((k, i) => [k, i] as const));
	const n = top.length;
	const mk = (): number[][] => [
		x,
		...Array.from({ length: n }, () => x.map(() => 0)),
	];
	const requests = mk();
	const throughput = mk();
	const failures = mk();
	const cache = mk();
	const latSum = mk();
	const latCnt = mk();
	for (const r of rows) {
		if (isProbeRow(r)) continue;
		const i = idx.get(monitorKey(dim, r));
		if (i === undefined) continue;
		const slot = Math.round((Date.parse(r.ts) - from) / hour);
		if (slot < 0 || slot >= x.length) continue;
		requests[i + 1][slot] += 1;
		throughput[i + 1][slot] += num(r.out_tok);
		if (failed(r)) failures[i + 1][slot] += 1;
		if ((r.cache_r ?? 0) > 0) cache[i + 1][slot] += 1;
		if (r.duration_ms !== null) {
			latSum[i + 1][slot] += r.duration_ms;
			latCnt[i + 1][slot] += 1;
		}
	}
	const latency = latSum.map((col, i) =>
		i === 0
			? col
			: col.map((sum, j) =>
					latCnt[i][j] > 0 ? Math.round(sum / latCnt[i][j]) : 0,
				),
	);
	return {
		x,
		labels: top,
		requests,
		throughput,
		failures,
		cache,
		latency,
	};
}

const WIRE_ROW_CAP = 200;

/** One monitor report: shared hub rows → dimension aggregates + series.
 *  Never throws on hub trouble — rows degrade to empty, hubs carry reasons. */
export async function monitorReport(
	opts: DrillOpts & {
		days?: number;
		dim?: MonitorDim;
		/** lane → work-type join (the W243 meter), supplied by the route. */
		work?: Record<string, LaneWork>;
		/** transcript-side meter slice, supplied by the board route. */
		transcripts?: TranscriptMeter;
		nowMs?: number;
	} = {},
): Promise<MonitorReport> {
	const dim = (MONITOR_DIMS as readonly string[]).includes(opts.dim ?? "")
		? (opts.dim as MonitorDim)
		: "lane";
	const now = opts.nowMs ?? Date.now();
	const { rows, hubs } = await collectHubRows({ ...opts, days: opts.days });
	const inference = rows.filter((r) => !isProbeRow(r));
	const probeCount = rows.length - inference.length;
	const agg = monitorAggregates(rows, dim, opts.work);
	const withVerdict = (r: BuckleRequestRow): boolean =>
		cacheKnown(r) || r.cache_reported === false;
	return {
		ok: true,
		ts: new Date(now).toISOString(),
		days: Math.min(90, Math.max(1, Math.trunc(opts.days ?? 7) || 7)),
		dim,
		hubs,
		rows: agg.slice(0, WIRE_ROW_CAP),
		series: monitorSeries(rows, dim, opts.days ?? 7, now),
		coverage: {
			requests: inference.length,
			probe_requests: probeCount,
			rows_with_tokens: inference.filter(
				(r) => r.in_tok !== null || r.out_tok !== null,
			).length,
			rows_with_duration: inference.filter((r) => r.duration_ms !== null)
				.length,
			rows_with_cache_verdict: inference.filter(withVerdict).length,
			rows_with_failure_verdict: inference.filter(
				(r) => r.ok !== null || r.status !== null,
			).length,
			per_hub_row_limit: Math.min(
				10_000,
				Math.max(1, Math.trunc(opts.hubRowLimit ?? 2000)),
			),
		},
		...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
	};
}
