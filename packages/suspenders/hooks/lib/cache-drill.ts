// hooks/lib/cache-drill.ts — W825: buckle per-request cache drilldown for the
// board. Consumes the W824 seam (GET /v1/admin/requests over the buckle
// ledger's route_audit rows: lane, target_model, cache_r/cache_c per request)
// with the cross-hub-usage pattern: hub labels from stack.yaml/hubs.json,
// per-hub fetch + honest degrade, TTL-cached raw rows. On top of the rows it
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
} from "./cross-hub-usage.ts";
import type { CrossHubEnv } from "./cross-hub-usage.ts";

// ─── wire mirror: one buckle route_audit row (ledger.ts is the contract) ───
export interface BuckleRequestRow {
	rid: string;
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
	/** optional extensions the seam may carry; null = not reported. */
	in_tok: number | null;
	out_tok: number | null;
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
		in_tok: num(r.in_tok),
		out_tok: num(r.out_tok),
	};
}

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
	let prev: BuckleRequestRow | null = null;
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
		const isMiss = row.cache_r === 0;
		const thisPrev = prev;
		prev = row;
		if (!isMiss) continue;
		if (thisPrev === null || thisPrev.lane !== row.lane) {
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
		if ((row.in_tok ?? 0) >= COLD_CONTEXT_TOK && (row.cache_c ?? 0) === 0) {
			add(
				"cold_full_context",
				"oversized fresh context",
				"large fresh input with no cache read and no cache write — nothing cacheable was hit; the body likely lacks stable prefixes (system prompt / tools placement)",
				row,
			);
			continue;
		}
		add(
			"unexplained",
			"unexplained (possible tools/system-prompt drift)",
			"no signal in the audit row separates tools-set from prompt drift — needs prefix-hash telemetry at the seam; cloned lanes sharing settings should NOT miss here",
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
	last_ts: string | null;
	/** distinct target models the lane rode (drift signal at a glance). */
	models: string[];
	hubs: string[];
	day_series: LaneDayCell[];
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
			last_ts: null,
			models: [],
			hubs: [],
			day_series: [],
			_days: new Map<string, LaneDayCell>(),
			_models: new Set<string>(),
			_hubs: new Set<string>(),
		};
		cur.requests += 1;
		if (r.cache_r !== null) {
			cur.known += 1;
			if (r.cache_r > 0) cur.warm += 1;
			else cur.misses += 1;
		}
		cur.cache_r_tok += r.cache_r ?? 0;
		cur.cache_c_tok += r.cache_c ?? 0;
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
			(f.lane === "" || r.lane === f.lane) &&
			(f.model === "" || r.target_model === f.model) &&
			(f.day === "" || r.ts.slice(0, 10) === f.day) &&
			(!f.missOnly || r.cache_r === 0),
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
	fetchedAt: string | null;
}

export type RequestFetcher = (
	url: string,
	token: string | null,
	days: number,
) => Promise<
	{ ok: true; rows: BuckleRequestRow[] } | { ok: false; why: string }
>;

/** One GET /v1/admin/requests against a hub base URL. Tolerant envelope:
 *  {ok:true, rows:[...]} is the expected shape (W824 seam); anything else
 *  degrades honestly. */
export async function fetchHubRequests(
	url: string,
	token: string | null,
	days: number,
	timeoutMs = 4000,
): Promise<
	{ ok: true; rows: BuckleRequestRow[] } | { ok: false; why: string }
> {
	try {
		const headers: Record<string, string> = {};
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const res = await fetch(`${url}/v1/admin/requests?days=${String(days)}`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 404)
			return { ok: false, why: "seam not served (pre-W824 hub)" };
		if (!res.ok)
			return { ok: false, why: `hub answered ${String(res.status)}` };
		const body = (await res.json()) as Record<string, unknown>;
		if (body.ok !== true || !Array.isArray(body.rows))
			return { ok: false, why: "envelope missing ok:true rows:[]" };
		const rows: BuckleRequestRow[] = [];
		for (const raw of body.rows) {
			const parsed = parseRequestRow(raw);
			if (parsed !== null) rows.push(parsed);
		}
		return { ok: true, rows };
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
		status.reason = "no url in stack.yaml/hubs.json for this label";
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

export interface CacheDrillReport {
	ok: true;
	ts: string;
	days: number;
	filters: CacheDrillFilters & { sort: CacheDrillSort; limit: number };
	hubs: HubDrillStatus[];
	/** per-lane aggregates over the FILTERED rows, sorted per `sort`. */
	lanes: LaneDrillRow[];
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
	const env = opts.env ?? (process.env as CacheDrillEnv);
	const labels = crossHubLabels({ env });
	const hubLimit = Math.min(
		10_000,
		Math.max(1, Math.trunc(opts.hubRowLimit ?? 2000)),
	);
	const hubs: HubDrillStatus[] = [];
	const all: BuckleRequestRow[] = [];
	for (const label of labels) {
		const out = await rowsForLabel(label, opts, days, hubLimit);
		hubs.push(out.status);
		all.push(...out.rows);
	}
	const rows = filterRows(all, filters);
	const lanes = sortLanes(laneAggregates(rows), sort);
	const known = rows.filter((r) => r.cache_r !== null).length;
	const warm = rows.filter((r) => (r.cache_r ?? 0) > 0).length;
	const scoped = filters.lane === "" ? null : rows;
	return {
		ok: true,
		ts: new Date(opts.nowMs ?? Date.now()).toISOString(),
		days,
		filters: { ...filters, sort, limit },
		hubs,
		lanes,
		overall: {
			requests: rows.length,
			known,
			warm,
			warm_ratio: known > 0 ? warm / known : 0,
			reasons: clusterMissReasons(rows),
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
