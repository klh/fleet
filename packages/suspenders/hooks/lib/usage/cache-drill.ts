// hooks/lib/usage/cache-drill.ts — W825: buckle per-request cache drilldown for the
// board. Consumes the W824 seam (GET /v1/admin/requests over the buckle
// ledger's route_audit rows: lane, target_model, cache_r/cache_c per request)
// with the cross-hub-usage pattern: the Mac spoke plus hub labels from
// stack.json/hubs.json, per-source fetch + honest degrade, TTL-cached rows. It
// shapes (1) per-lane aggregates with the warm-cache ratio — share of a
// lane's requests that HIT cache (cache_r > 0), the owner's clone-reuse
// metric — and (2) miss-reason clusters: not just miss counts, the likely
// CAUSE per miss (cold start, gap expiry, target drift, settings drift,
// oversized fresh context), each with an example rid and a next action.
// A hub that does not serve the seam yet (pre-W824) degrades to a row with
// ok:false + reason — the panels stay honest until it lands.
import {
	envToken,
	resolveHubEndpoints,
	crossHubLabels,
} from "../federation/cross-hub-usage.ts";
import type { CrossHubEnv } from "../federation/cross-hub-usage.ts";
import { readAdminKey } from "../fleet-loop/doctor.ts";
import { tryLoadStack } from "../stack-config.ts";

// ─── wire mirror: one buckle route_audit row (ledger.ts is the contract) ───
export interface BuckleRequestRow {
	rid: string;
	/** W3C trace ID, null for Buckle rows written before the trace migration. */
	trace_id: string | null;
	ts: string;
	/** /w/<slug> slug when the request rode a lane ingress; '' for bare. */
	lane: string;
	/** truncated key id (credential), never key material. */
	actor: string;
	dialect: string;
	hint: string;
	candidates_seen: number;
	candidates_top: string;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
	decision: string;
	latency_class: string;
	tier: string;
	allow_cloud: boolean;
	error_code: string | null;
	why: string;
	hop: string;
	status: number | null;
	duration_ms: number | null;
	ok: boolean | null;
	err: string | null;
	/** provider-reported cache tokens; null = usage unknown (honest). */
	cache_r: number | null;
	cache_c: number | null;
	cache_reported: boolean | null;
	/** Cache-write field presence. NULL means an older gateway did not record it. */
	cache_c_reported: boolean | null;
	/** optional extensions the seam may carry; null = not reported. */
	in_tok: number | null;
	out_tok: number | null;
	/** W921 traffic kind: 'readiness' = marked root-auth healthcheck
	 *  synthetic (excluded from cache analytics), 'inference' = agent
	 *  traffic, null = the row predates the column. */
	traffic_kind: string | null;
	/** hub label the row was fetched from (set by this lib, not the wire). */
	hub?: string;
}

const num = (x: unknown): number | null =>
	typeof x === "number" && Number.isFinite(x) ? x : null;
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const bool = (x: unknown): boolean | null =>
	typeof x === "boolean" ? x : null;

/** Tolerant row parse — unknown/garbled entries land null and the row stays
 *  usable for counting; only rid+ts must be present to count at all. */
export function parseRequestRow(raw: unknown): BuckleRequestRow | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const rid = str(r.rid);
	const ts = str(r.ts);
	if (!rid || !ts || Number.isNaN(Date.parse(ts))) return null;
	return {
		rid,
		trace_id: /^[0-9a-f]{32}$/.test(str(r.trace_id)) ? str(r.trace_id) : null,
		ts,
		lane: str(r.lane),
		actor: str(r.actor),
		dialect: str(r.dialect),
		hint: str(r.hint),
		candidates_seen: num(r.candidates_seen) ?? 0,
		candidates_top: str(r.candidates_top),
		target_kind: str(r.target_kind) || null,
		target_host: str(r.target_host) || null,
		target_port: num(r.target_port),
		target_model: str(r.target_model) || null,
		decision: str(r.decision),
		latency_class: str(r.latency_class),
		tier: str(r.tier),
		allow_cloud: bool(r.allow_cloud) ?? false,
		error_code: str(r.error_code) || null,
		why: str(r.why),
		hop: str(r.hop),
		status: num(r.status),
		duration_ms: num(r.duration_ms),
		ok: bool(r.ok),
		err: str(r.err) || null,
		cache_r: num(r.cache_r),
		cache_c: num(r.cache_c),
		cache_reported:
			bool(r.cache_reported) ??
			(r.cache_reported === 1 ? true : r.cache_reported === 0 ? false : null),
		cache_c_reported:
			bool(r.cache_c_reported) ??
			(r.cache_c_reported === 1
				? true
				: r.cache_c_reported === 0
					? false
					: null),
		in_tok: num(r.in_tok),
		out_tok: num(r.out_tok),
		traffic_kind: str(r.traffic_kind) || null,
	};
}

/** A row's cache verdict is KNOWN when the provider reported it (or a warm
 *  read made it obvious) — the shared "known vs unknown" predicate. */
export const cacheKnown = (row: BuckleRequestRow): boolean =>
	row.cache_reported === true || (row.cache_r ?? 0) > 0;

/** W921: readiness probes (marked root-auth healthcheck synthetics) are
 *  infrastructure, not agent traffic — excluded from every lane/model cache
 *  ratio and miss-reason cluster, shown separately by the report. */
export const isProbeRow = (row: BuckleRequestRow): boolean =>
	row.traffic_kind === "readiness";

// ─── miss-reason clusters ─────────────────────────────────────────────────
/** Inter-request gap above which a cold cache is EXPECTED (provider prompt
 *  caches expire in minutes; 10 min is the conservative edge). */
const GAP_EXPIRY_MS = 10 * 60_000;
/** A fresh context this large with zero cache read AND zero cache write
 *  means nothing cacheable was hit at all — oversized fresh context. */
const COLD_CONTEXT_TOK = 50_000;

export interface MissReasonCluster {
	/** stable key the UI keys on */
	reason: string;
	label: string;
	count: number;
	example_rid: string;
	/** what to do about it — the panel is optimization-oriented */
	detail: string;
}

/** A lane's rows (one lane or all lanes) sorted by ts, walked once; every
 *  MISS (cache_r === 0) falls into the first matching rule. Rows with
 *  unknown usage (cache_r === null) never count as misses. */
export function clusterMissReasons(
	rows: BuckleRequestRow[],
): MissReasonCluster[] {
	const byKey = new Map<string, MissReasonCluster>();
	const previousByLane = new Map<string, BuckleRequestRow>();
	const add = (
		reason: string,
		label: string,
		detail: string,
		row: BuckleRequestRow,
	): void => {
		const cur = byKey.get(reason) ?? {
			reason,
			label,
			count: 0,
			example_rid: row.rid,
			detail,
		};
		cur.count += 1;
		byKey.set(reason, cur);
	};
	for (const row of [...rows].sort((a, b) => a.ts.localeCompare(b.ts))) {
		if (isProbeRow(row)) continue;
		const isMiss = cacheKnown(row) && row.cache_r === 0;
		const thisPrev = previousByLane.get(row.lane) ?? null;
		if (row.lane) previousByLane.set(row.lane, row);
		if (!isMiss) continue;
		if (!row.lane) {
			add(
				"unattributed",
				"unattributed ingress",
				"this request did not ride /w/<lane>; route agent traffic through its lane URL before diagnosing cache misses",
				row,
			);
			continue;
		}
		if (thisPrev === null) {
			add(
				"cold_start",
				"cold start",
				"first request of this lane in the window — cache cannot be warm yet; recurring cold starts on one lane mean the lane idles past cache TTL between turns",
				row,
			);
			continue;
		}
		const gapMs = Date.parse(row.ts) - Date.parse(thisPrev.ts);
		if (gapMs > GAP_EXPIRY_MS) {
			add(
				"gap_expiry",
				"gap past cache TTL",
				"the lane went quiet longer than a prompt cache lives — bursts of work on a shared cloned prefix beat idle stretches",
				row,
			);
			continue;
		}
		if (
			row.target_model !== null &&
			thisPrev.target_model !== null &&
			row.target_model !== thisPrev.target_model
		) {
			add(
				"target_drift",
				"target/model drift",
				"the router flipped this lane between targets/models back-to-back — every flip rebuilds the provider prefix cache; pin the lane's model group or widen affinity",
				row,
			);
			continue;
		}
		if (row.dialect !== thisPrev.dialect || row.tier !== thisPrev.tier) {
			add(
				"settings_drift",
				"dialect/tier drift",
				"the lane's dialect or ladder tier changed between requests — settings/stack drift invalidates the cached prefix; keep one lane on one posture",
				row,
			);
			continue;
		}
		if ((row.in_tok ?? 0) >= COLD_CONTEXT_TOK) {
			add(
				"cold_full_context",
				"large uncached context",
				"large input with no cache read; inspect the stable prefix and provider cache settings before assuming writes failed",
				row,
			);
			continue;
		}
		add(
			"unexplained",
			"unexplained cache miss",
			"request metadata cannot separate tool or system-prompt changes; compare prefix hashes before changing routing",
			row,
		);
	}
	return [...byKey.values()].sort((a, b) => b.count - a.count);
}

// ─── per-lane aggregates ──────────────────────────────────────────────────
export interface LaneDayCell {
	d: string;
	req: number;
	warm: number;
}

export interface LaneDrillRow {
	lane: string;
	requests: number;
	/** requests with a KNOWN cache verdict (cache_r !== null). */
	known: number;
	/** known requests that HIT cache (cache_r > 0). */
	warm: number;
	/** warm/known over the window — the clone-reuse metric. */
	warm_ratio: number;
	misses: number;
	cache_r_tok: number;
	cache_c_tok: number;
	cache_c_known: number;
	last_ts: string | null;
	/** distinct target models the lane rode (drift signal at a glance). */
	models: string[];
	hubs: string[];
	day_series: LaneDayCell[];
}

/** W921: the separately-reported readiness-probe traffic (marked root-auth
 *  healthcheck synthetics). Never inside the lane/model ratios or reasons. */
export interface ProbeTrafficSummary {
	requests: number;
	known: number;
	warm: number;
	warm_ratio: number;
	last_ts: string | null;
}

export interface ModelDrillRow {
	model: string;
	requests: number;
	known: number;
	warm: number;
	warm_ratio: number;
	cache_r_tok: number;
	cache_c_tok: number;
	cache_c_known: number;
	status: "measured" | "partial" | "unsupported" | "not reported";
}

export function modelAggregates(
	rows: BuckleRequestRow[],
	unsupportedModels: string[] = [],
): ModelDrillRow[] {
	const unsupported = new Set(unsupportedModels);
	const byModel = new Map<string, ModelDrillRow>();
	for (const row of rows) {
		if (isProbeRow(row)) continue;
		const model = row.target_model ?? "(unrouted)";
		const current = byModel.get(model) ?? {
			model,
			requests: 0,
			known: 0,
			warm: 0,
			warm_ratio: 0,
			cache_r_tok: 0,
			cache_c_tok: 0,
			cache_c_known: 0,
			status: "not reported" as const,
		};
		current.requests++;
		if (cacheKnown(row)) {
			current.known++;
			if ((row.cache_r ?? 0) > 0) current.warm++;
		}
		current.cache_r_tok += row.cache_r ?? 0;
		if (row.cache_c_reported) {
			current.cache_c_known++;
			current.cache_c_tok += row.cache_c ?? 0;
		}
		byModel.set(model, current);
	}
	return [...byModel.values()]
		.map((model) => ({
			...model,
			warm_ratio: model.known > 0 ? model.warm / model.known : 0,
			status:
				model.known > 0
					? model.known === model.requests
						? ("measured" as const)
						: ("partial" as const)
					: unsupported.has(model.model)
						? ("unsupported" as const)
						: ("not reported" as const),
		}))
		.sort((a, b) => b.requests - a.requests);
}

export function laneAggregates(rows: BuckleRequestRow[]): LaneDrillRow[] {
	const byLane = new Map<
		string,
		LaneDrillRow & {
			_days: Map<string, LaneDayCell>;
			_models: Set<string>;
			_hubs: Set<string>;
		}
	>();
	for (const r of rows) {
		if (isProbeRow(r)) continue;
		const lane = r.lane === "" ? "(bare ingress)" : r.lane;
		const cur = byLane.get(lane) ?? {
			lane,
			requests: 0,
			known: 0,
			warm: 0,
			warm_ratio: 0,
			misses: 0,
			cache_r_tok: 0,
			cache_c_tok: 0,
			cache_c_known: 0,
			last_ts: null,
			models: [],
			hubs: [],
			day_series: [],
			_days: new Map<string, LaneDayCell>(),
			_models: new Set<string>(),
			_hubs: new Set<string>(),
		};
		cur.requests += 1;
		if (cacheKnown(r)) {
			cur.known += 1;
			if (r.cache_r > 0) cur.warm += 1;
			else cur.misses += 1;
		}
		cur.cache_r_tok += r.cache_r ?? 0;
		if (r.cache_c_reported) {
			cur.cache_c_known++;
			cur.cache_c_tok += r.cache_c ?? 0;
		}
		if (cur.last_ts === null || r.ts > cur.last_ts) cur.last_ts = r.ts;
		if (r.target_model) cur._models.add(r.target_model);
		if (r.hub) cur._hubs.add(r.hub);
		const d = r.ts.slice(0, 10);
		const cell = cur._days.get(d) ?? { d, req: 0, warm: 0 };
		cell.req += 1;
		if ((r.cache_r ?? 0) > 0) cell.warm += 1;
		cur._days.set(d, cell);
		byLane.set(lane, cur);
	}
	return [...byLane.values()].map((c) => ({
		lane: c.lane,
		requests: c.requests,
		known: c.known,
		warm: c.warm,
		warm_ratio: c.known > 0 ? c.warm / c.known : 0,
		misses: c.misses,
		cache_r_tok: c.cache_r_tok,
		cache_c_tok: c.cache_c_tok,
		cache_c_known: c.cache_c_known,
		last_ts: c.last_ts,
		models: [...c._models].sort(),
		hubs: [...c._hubs].sort(),
		day_series: [...c._days.values()].sort((a, b) => a.d.localeCompare(b.d)),
	}));
}

// ─── filters ──────────────────────────────────────────────────────────────
export interface CacheDrillFilters {
	/** lane slug ('' = all lanes, aggregates only). */
	lane: string;
	/** target_model exact match ('' = any). */
	model: string;
	/** YYYY-MM-DD day filter on ts ('' = whole window). */
	day: string;
	/** true = only rows with a known cache verdict of 0 (misses). */
	missOnly: boolean;
}

export function filterRows(
	rows: BuckleRequestRow[],
	f: CacheDrillFilters,
): BuckleRequestRow[] {
	return rows.filter(
		(r) =>
			(f.lane === "" ||
				(f.lane === "(bare ingress)" ? r.lane === "" : r.lane === f.lane)) &&
			(f.model === "" || r.target_model === f.model) &&
			(f.day === "" || r.ts.slice(0, 10) === f.day) &&
			(!f.missOnly || (cacheKnown(r) && r.cache_r === 0)),
	);
}

export type CacheDrillSort = "least_warm" | "most_requests" | "recent";

export function sortLanes(
	lanes: LaneDrillRow[],
	sort: CacheDrillSort,
): LaneDrillRow[] {
	const sorted = [...lanes];
	if (sort === "most_requests") sorted.sort((a, b) => b.requests - a.requests);
	else if (sort === "recent")
		sorted.sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""));
	// least_warm is the default: worst cache offenders first — sorted by
	// miss ratio (known desc as tiebreak so all-cold lanes with traffic win)
	else
		sorted.sort((a, b) =>
			b.known > 0 || a.known > 0
				? a.warm_ratio - b.warm_ratio || b.known - a.known
				: b.requests - a.requests,
		);
	return sorted;
}

// ─── hub fetch layer (cross-hub pattern) ──────────────────────────────────
export interface HubDrillStatus {
	label: string;
	ok: boolean;
	unresolved: boolean;
	reason: string | null;
	url: string | null;
	via: string | null;
	rows: number;
	/** Non-model audit rows returned by a hub that ignored inference=true. */
	excluded?: number;
	rawRows?: number;
	fetchedAt: string | null;
}

export type RequestFetcher = (
	url: string,
	token: string | null,
	days: number,
) => Promise<
	| { ok: true; rows: BuckleRequestRow[]; excluded?: number; rawRows?: number }
	| { ok: false; why: string }
>;

/** One GET /v1/admin/requests against a hub base URL. The W824 admin route
 *  returns {requests:[...]}, capped at 500 rows per read. */
export async function fetchHubRequests(
	url: string,
	token: string | null,
	days: number,
	timeoutMs = 4000,
): Promise<
	| { ok: true; rows: BuckleRequestRow[]; excluded?: number; rawRows?: number }
	| { ok: false; why: string }
> {
	try {
		const headers: Record<string, string> = {};
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const since = new Date(Date.now() - days * 86_400_000).toISOString();
		const query = new URLSearchParams({
			since,
			limit: "500",
			inference: "true",
		});
		const res = await fetch(`${url}/v1/admin/requests?${query.toString()}`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 404)
			return { ok: false, why: "seam not served (pre-W824 hub)" };
		if (!res.ok)
			return { ok: false, why: `hub answered ${String(res.status)}` };
		const body = (await res.json()) as Record<string, unknown>;
		if (!Array.isArray(body.requests))
			return { ok: false, why: "envelope missing requests:[]" };
		const rows: BuckleRequestRow[] = [];
		let excluded = 0;
		for (const raw of body.requests) {
			const parsed = parseRequestRow(raw);
			if (parsed?.target_model) rows.push(parsed);
			else if (parsed !== null) excluded++;
		}
		return { ok: true, rows, excluded, rawRows: body.requests.length };
	} catch (e) {
		return { ok: false, why: String(e) };
	}
}

// TTL cache of RAW hub rows, keyed label+days (filters re-run per request —
// the /api drilldown stays cheap between reloads, cross-hub-usage's pattern).
const rowCache = new Map<
	string,
	{ atMs: number; rows: BuckleRequestRow[]; status: HubDrillStatus }
>();

/** Test seam — drops every TTL-cached hub row set. */
export function clearCacheDrillTtl(): void {
	rowCache.clear();
}

export interface CacheDrillEnv extends CrossHubEnv {
	SUSPENDERS_CACHE_DRILL_TTL_MS?: string;
	SUSPENDERS_CACHE_LOCAL?: string;
	BUCKLE_SPOKE_URL?: string;
}

export interface DrillOpts {
	days?: number;
	env?: CacheDrillEnv;
	nowMs?: number;
	ttlMs?: number;
	/** Label → endpoints seam (tests). */
	endpoints?: (
		label: string,
	) => { url: string; via: string; token: string | null }[];
	/** Fetch seam (tests). */
	fetch?: RequestFetcher;
	fresh?: boolean;
	/** Raw-row ceiling per hub (default 2000, clamp 1..10000). */
	hubRowLimit?: number;
}

/** Pull rows for one label (TTL-cached), tagging each row with the hub. */
async function rowsForLabel(
	label: string,
	opts: DrillOpts,
	days: number,
	limit: number,
): Promise<{ rows: BuckleRequestRow[]; status: HubDrillStatus }> {
	const env = opts.env ?? (process.env as CacheDrillEnv);
	const now = opts.nowMs ?? Date.now();
	const ttlMs =
		opts.ttlMs ??
		(env.SUSPENDERS_CACHE_DRILL_TTL_MS !== undefined
			? Number(env.SUSPENDERS_CACHE_DRILL_TTL_MS) || 300_000
			: 300_000);
	const key = `${label}:${String(days)}`;
	const cached = rowCache.get(key);
	if (!opts.fresh && cached !== undefined && now - cached.atMs < ttlMs)
		return { rows: cached.rows, status: cached.status };
	const eps = opts.endpoints
		? opts.endpoints(label)
		: label === "local"
			? [
					{
						url: (env.BUCKLE_SPOKE_URL ?? "http://127.0.0.1:4101").replace(
							/\/$/,
							"",
						),
						via: "Mac spoke",
						token:
							env.BUCKLE_ADMIN_KEY ??
							readAdminKey(
								`${env.HOME ?? process.env.HOME ?? ""}/.claude/local-llm/belt.env`,
							),
					},
				]
			: resolveHubEndpoints(label, { env });
	const token = envToken(env);
	const fetchOne = opts.fetch ?? fetchHubRequests;
	const status: HubDrillStatus = {
		label,
		ok: false,
		unresolved: false,
		reason: null,
		url: null,
		via: null,
		rows: 0,
		fetchedAt: null,
	};
	if (eps.length === 0) {
		status.unresolved = true;
		status.reason = "no url in stack.json/hubs.json for this label";
		rowCache.set(key, { atMs: now, rows: [], status });
		return { rows: [], status };
	}
	let lastWhy = "no endpoint tried";
	for (const ep of eps) {
		const out = await fetchOne(ep.url, ep.token ?? token, days);
		if (out.ok) {
			status.ok = true;
			status.url = ep.url;
			status.via = ep.via;
			status.fetchedAt = new Date(now).toISOString();
			status.rows = out.rows.length;
			status.excluded = out.excluded ?? 0;
			status.rawRows = out.rawRows ?? out.rows.length;
			const rows = out.rows.slice(-limit).map((r) => ({ ...r, hub: label }));
			rowCache.set(key, { atMs: now, rows, status });
			return { rows, status };
		}
		lastWhy = out.why;
	}
	status.reason = lastWhy;
	rowCache.set(key, { atMs: now, rows: [], status });
	return { rows: [], status };
}

/** W995: shared row collection — enumerate hubs → TTL-cached rows, tagging
 *  each row with the hub. The ONE label loop; cacheDrillReport and the
 *  usage monitor both collect through it. */
export async function collectHubRows(
	opts: DrillOpts & { days?: number } = {},
): Promise<{ rows: BuckleRequestRow[]; hubs: HubDrillStatus[] }> {
	const days = Math.min(90, Math.max(1, Math.trunc(opts.days ?? 7) || 7));
	const env = opts.env ?? (process.env as CacheDrillEnv);
	const labels = crossHubLabels({ env });
	if (
		process.platform === "darwin" &&
		env.SUSPENDERS_CACHE_LOCAL !== "0" &&
		!labels.includes("local")
	)
		labels.unshift("local");
	const hubLimit = Math.min(
		10_000,
		Math.max(1, Math.trunc(opts.hubRowLimit ?? 2000)),
	);
	const hubs: HubDrillStatus[] = [];
	const rows: BuckleRequestRow[] = [];
	for (const label of labels) {
		const out = await rowsForLabel(label, opts, days, hubLimit);
		hubs.push(out.status);
		rows.push(...out.rows);
	}
	return { rows, hubs };
}

export interface CacheDrillReport {
	ok: true;
	ts: string;
	days: number;
	filters: CacheDrillFilters & { sort: CacheDrillSort; limit: number };
	hubs: HubDrillStatus[];
	/** Separate local Claude transcript meter; supplied by the board route. */
	local_transcripts?: {
		cache_read_tokens: number;
		requests: number;
		source: "transcript-v2" | "legacy-aggregate";
	};
	/** per-lane aggregates over the FILTERED rows, sorted per `sort`. */
	lanes: LaneDrillRow[];
	models: ModelDrillRow[];
	/** W921: probe traffic over the FILTERED rows, reported separately —
	 *  the lane/model aggregates and miss reasons exclude it. */
	probes: ProbeTrafficSummary;
	overall: {
		requests: number;
		known: number;
		warm: number;
		warm_ratio: number;
		reasons: MissReasonCluster[];
	};
	/** populated when filters.lane is set: that lane's requests + reasons. */
	lane_scope: {
		lane: string;
		requests: BuckleRequestRow[];
		reasons: MissReasonCluster[];
	} | null;
}

/** One drilldown report: enumerate hubs → TTL-cached rows → filters →
 *  aggregates + reason clusters. Never throws on hub trouble — rows degrade
 *  to empty and the hubs[] statuses carry the reasons. */
export async function cacheDrillReport(
	opts: DrillOpts & {
		filters?: Partial<CacheDrillFilters & { sort: string; limit: number }>;
	} = {},
): Promise<CacheDrillReport> {
	const days = Math.min(90, Math.max(1, Math.trunc(opts.days ?? 7) || 7));
	const f = opts.filters ?? {};
	const filters: CacheDrillFilters = {
		lane: typeof f.lane === "string" ? f.lane : "",
		model: typeof f.model === "string" ? f.model : "",
		day: typeof f.day === "string" ? f.day : "",
		missOnly: f.missOnly === true,
	};
	const sort: CacheDrillSort =
		f.sort === "most_requests" || f.sort === "recent" ? f.sort : "least_warm";
	const limit = Math.min(1000, Math.max(1, Math.trunc(f.limit ?? 200) || 200));
	const { rows: all, hubs } = await collectHubRows({ ...opts, days });
	const rows = filterRows(all, filters);
	// W921: every cache ratio / reason cluster is INFERENCE-only — probe
	// traffic is summed separately and reported on its own.
	const inference = rows.filter((r) => !isProbeRow(r));
	const lanes = sortLanes(laneAggregates(rows), sort);
	const models = modelAggregates(
		rows,
		tryLoadStack()?.cache_unsupported_models ?? [],
	);
	const known = inference.filter(cacheKnown).length;
	const warm = inference.filter((r) => (r.cache_r ?? 0) > 0).length;
	const probeRows = rows.filter(isProbeRow);
	const probeKnown = probeRows.filter(cacheKnown).length;
	const probeWarm = probeRows.filter((r) => (r.cache_r ?? 0) > 0).length;
	const scoped = filters.lane === "" ? null : rows;
	return {
		ok: true,
		ts: new Date(opts.nowMs ?? Date.now()).toISOString(),
		days,
		filters: { ...filters, sort, limit },
		hubs,
		lanes,
		models,
		overall: {
			requests: inference.length,
			known,
			warm,
			warm_ratio: known > 0 ? warm / known : 0,
			reasons: clusterMissReasons(rows),
		},
		probes: {
			requests: probeRows.length,
			known: probeKnown,
			warm: probeWarm,
			warm_ratio: probeKnown > 0 ? probeWarm / probeKnown : 0,
			last_ts: probeRows.reduce<string | null>(
				(latest, r) => (latest === null || r.ts > latest ? r.ts : latest),
				null,
			),
		},
		lane_scope:
			scoped === null
				? null
				: {
						lane: filters.lane,
						requests: [...scoped]
							.sort((a, b) => b.ts.localeCompare(a.ts))
							.slice(0, limit),
						reasons: clusterMissReasons(scoped),
					},
	};
}

// ─── route param parsing (pure; the board route stays thin) ───────────────
export function cacheDrillParams(url: URL): {
	days: number;
	filters: Partial<CacheDrillFilters & { sort: string; limit: number }>;
} {
	const p = url.searchParams;
	const lane = p.get("lane") ?? "";
	return {
		days: Number(p.get("days") ?? 7) || 7,
		filters: {
			lane,
			model: p.get("model") ?? "",
			day: p.get("day") ?? "",
			missOnly: p.get("miss_only") === "1",
			sort: p.get("sort") ?? "",
			limit: Number(p.get("limit") ?? 200) || 200,
		},
	};
}
