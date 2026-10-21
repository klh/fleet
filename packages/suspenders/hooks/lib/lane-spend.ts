// hooks/lib/lane-spend.ts — W635 cost-per-DONE-item. Joins the buckle
// ledger's router_usage (hour-bucket token rollup keyed by API key id) to
// work-graph claim windows: api_keys.name for a per-lane minted key is the
// lane sid (dispatch mints name=sid, scope buckle:proxy:WRITE_), so
// router_usage ⋈ api_keys gives per-lane spend, and claimWindows gives
// per-item attribution. Same honesty rules as W24 tokenUsage: attribution is
// claim-window overlap in time, not causality; a missing or unreadable
// ledger fails soft (no cost section — metrics never blocks on the gateway).

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	type ClaimWindow,
	claimWindows,
	type TimingEventRow,
	workTiming,
} from "./work-timing.ts";

/** W943.1 — the cache-blind era. router_usage rows written before the
 *  2026-10-19 buckle-front fix carry cache_r/cache_c ≈ 0 (glm hourly sums:
 *  ≤132k tok through 2026-10-19T09, 72.2M at T10), so CACHE summed over
 *  earlier buckets is a floor, not a measurement. First bucket with
 *  trustworthy cache accounting; bucket strings compare lexicographically.
 *  SUSPENDERS_CACHE_ERA_FIX overrides (tests, machine config). */
export const CACHE_ERA_FIX_BUCKET = "2026-10-19T10:00";

export const cacheEraFixBucket = (): string =>
	process.env.SUSPENDERS_CACHE_ERA_FIX || CACHE_ERA_FIX_BUCKET;

/** Per model_class (model_group) spend split (W776: the class dimension). */
export interface GroupSpend {
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
	requests: number;
}

/** One hour-bucket spend row from the buckle ledger. */
export interface LaneSpendRow {
	bucket: string; // "YYYY-MM-DDTHH:00" UTC (toISOString().slice(0,13)+":00")
	sid: string; // api_keys.name = lane sid (per-lane minted keys)
	group: string; // router_usage.model_group — the class dimension
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
	requests: number;
}

/** Per-item attributed spend with its per-class (model_group) split. */
export interface ItemSpend {
	work: string;
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
	requests: number;
	/** W943.1: earliest attributed hour bucket, null = no attributed spend. */
	firstBucket: string | null;
	groups: Map<string, GroupSpend>;
}

/** One spend-over-time point: an attributed hour bucket's tokens. */
export interface ItemSpendPoint {
	t: number; // bucket start ms (UTC)
	fresh: number; // non-cache prompt tokens (in)
	cached: number; // cacheR + cacheC
	out: number;
}

/** One completed Buckle request with usage, kept at request precision. */
export interface LaneRequestSpendRow {
	ts: number;
	sid: string;
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
}

export const REQUEST_SPARK_BUCKET_MS = 60_000;

/** Resolve the buckle ledger path: SUSPENDERS_BUCKLE_DB env pin, then the
 *  documented spoke home. Config-over-code — only channel names, no paths
 *  beyond the documented spoke layout. null = no readable ledger. */
export function resolveBuckleDb(home = process.env.HOME ?? ""): string | null {
	const env = process.env.SUSPENDERS_BUCKLE_DB;
	if (env && existsSync(env)) return env;
	const spoke = home ? `${home}/.claude/local-llm/buckle.db` : "";
	return spoke && existsSync(spoke) ? spoke : null;
}

/** Per-lane, per-hour, per-model_group token spend from the buckle ledger.
 *  `fromBucket` is a "YYYY-MM-DDTHH:00" UTC lower bound (lexicographic). */
export function laneSpendRows(
	dbPath: string,
	fromBucket: string,
): LaneSpendRow[] {
	const d = new Database(dbPath, { readonly: true });
	try {
		const rows = d
			.query(
				`SELECT ru.hour_bucket AS bucket, ak.name AS sid, ru.model_group AS grp,
				  SUM(ru.in_tok) AS i, SUM(ru.out_tok) AS o,
				  SUM(ru.cache_r) AS cr, SUM(ru.cache_c) AS cc, SUM(ru.requests) AS req
				 FROM router_usage ru JOIN api_keys ak ON ak.key_id = ru.key
				 WHERE ru.hour_bucket >= ?
				 GROUP BY ru.hour_bucket, ak.name, ru.model_group
				 ORDER BY ru.hour_bucket`,
			)
			.all(fromBucket) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			bucket: String(r.bucket),
			sid: String(r.sid),
			group: String(r.grp),
			inTok: Number(r.i),
			outTok: Number(r.o),
			cacheR: Number(r.cr),
			cacheC: Number(r.cc),
			requests: Number(r.req),
		}));
	} finally {
		d.close();
	}
}

/** Recent per-request usage for live charts. The hourly router_usage table
 * cannot show a time series for a lane younger than an hour. Older ledgers
 * without route_audit usage columns yield no points rather than invented ones. */
export function laneRequestSpendRows(
	dbPath: string,
	fromIso: string,
): LaneRequestSpendRow[] {
	const d = new Database(dbPath, { readonly: true });
	try {
		const rows = d
			.query(
				"SELECT ts, lane, in_tok, out_tok, cache_r, cache_c FROM route_audit WHERE ts >= ? AND lane <> '' AND in_tok IS NOT NULL ORDER BY ts",
			)
			.all(fromIso) as Array<Record<string, unknown>>;
		return rows
			.map((r) => ({
				ts: Date.parse(String(r.ts)),
				sid: String(r.lane),
				inTok: Number(r.in_tok) || 0,
				outTok: Number(r.out_tok) || 0,
				cacheR: Number(r.cache_r) || 0,
				cacheC: Number(r.cache_c) || 0,
			}))
			.filter((r) => Number.isFinite(r.ts));
	} catch {
		return [];
	} finally {
		d.close();
	}
}

/** Attributed ledger rows per item per hour bucket — the shared core of the
 *  totals (itemSpend) and the time-series (itemSpendSeries) reductions.
 *  Same attribution rules as the W635 walk: a bucket attributes ONCE per
 *  item (first matching window); spend on lanes with no matching claim
 *  window is never attributed. */
function attributeBuckets(
	rows: LaneSpendRow[],
	windows: Map<string, ClaimWindow[]>,
): Map<string, Map<string, LaneSpendRow[]>> {
	const bySid = new Map<string, LaneSpendRow[]>();
	for (const r of rows) {
		const arr = bySid.get(r.sid);
		if (arr) arr.push(r);
		else bySid.set(r.sid, [r]);
	}
	const attributed = new Set<LaneSpendRow>();
	const out = new Map<string, Map<string, LaneSpendRow[]>>();
	for (const [work, ws] of windows) {
		for (const w of ws) {
			const rs = bySid.get(w.sid);
			if (!rs) continue;
			for (const r of rs) {
				const start = Date.parse(`${r.bucket}:00Z`);
				if (
					!Number.isFinite(start) ||
					start + 3_600_000 <= w.start ||
					start >= w.end
				)
					continue;
				if (attributed.has(r)) continue; // once per (item, bucket, sid)
				attributed.add(r);
				let fw = out.get(work);
				if (!fw) {
					fw = new Map();
					out.set(work, fw);
				}
				const fb = fw.get(r.bucket);
				if (fb) fb.push(r);
				else fw.set(r.bucket, [r]);
			}
		}
	}
	return out;
}

/** Attribute lane spend to items via claim windows. A bucket overlaps a
 *  window when the bucket's HOUR INTERVAL [start, start+1h) intersects
 *  [window.start, window.end) — partial-hour buckets attribute to the
 *  overlapping window, so sub-hour claims never lose their spend. Each
 *  bucket attributes ONCE per item (first matching window — hour buckets
 *  can straddle sequential re-claims; summing would double-count). Spend
 *  on lanes with no matching claim window is never attributed. */
export function itemSpend(
	rows: LaneSpendRow[],
	windows: Map<string, ClaimWindow[]>,
): Map<string, ItemSpend> {
	const out = new Map<string, ItemSpend>();
	for (const work of windows.keys()) {
		out.set(work, {
			work,
			in: 0,
			out: 0,
			cacheR: 0,
			cacheC: 0,
			requests: 0,
			firstBucket: null,
			groups: new Map(),
		});
	}
	for (const [work, forBucket] of attributeBuckets(rows, windows)) {
		const t = out.get(work);
		if (!t) continue;
		for (const [bucket, rs] of forBucket) {
			if (t.firstBucket === null || bucket < t.firstBucket)
				t.firstBucket = bucket;
			for (const r of rs) {
				t.in += r.inTok;
				t.out += r.outTok;
				t.cacheR += r.cacheR;
				t.cacheC += r.cacheC;
				t.requests += r.requests;
				const g =
					t.groups.get(r.group) ??
					({ in: 0, out: 0, cacheR: 0, cacheC: 0, requests: 0 } as const);
				t.groups.set(r.group, {
					in: g.in + r.inTok,
					out: g.out + r.outTok,
					cacheR: g.cacheR + r.cacheR,
					cacheC: g.cacheC + r.cacheC,
					requests: g.requests + r.requests,
				});
			}
		}
	}
	return out;
}

/** W887 — per-item spend-over-time: one point per attributed hour bucket,
 *  oldest first, capped at the newest `cap` buckets (bucket strings sort
 *  lexicographically). The sparkline surface, not a replay surface. */
export function itemSpendSeries(
	rows: LaneSpendRow[],
	windows: Map<string, ClaimWindow[]>,
	cap = 72,
): Map<string, ItemSpendPoint[]> {
	const out = new Map<string, ItemSpendPoint[]>();
	for (const [work, forBucket] of attributeBuckets(rows, windows)) {
		const keys = [...forBucket.keys()].sort().slice(-cap);
		const points: ItemSpendPoint[] = [];
		for (const b of keys) {
			let fresh = 0;
			let cached = 0;
			let o = 0;
			for (const r of forBucket.get(b) ?? []) {
				fresh += r.inTok;
				cached += r.cacheR + r.cacheC;
				o += r.outTok;
			}
			points.push({ t: Date.parse(`${b}:00Z`), fresh, cached, out: o });
		}
		out.set(work, points);
	}
	return out;
}

/** Attribute each request to the work item owning its lane at that instant,
 * then reduce into one-minute buckets. Gaps remain gaps in the wire shape. */
export function itemRequestSpendSeries(
	rows: LaneRequestSpendRow[],
	windows: Map<string, ClaimWindow[]>,
	cap = 120,
): Map<string, ItemSpendPoint[]> {
	const bySid = new Map<string, LaneRequestSpendRow[]>();
	for (const r of rows) {
		const group = bySid.get(r.sid) ?? [];
		group.push(r);
		bySid.set(r.sid, group);
	}
	const used = new Set<LaneRequestSpendRow>();
	const out = new Map<string, ItemSpendPoint[]>();
	for (const [work, ws] of windows) {
		const buckets = new Map<number, ItemSpendPoint>();
		for (const w of ws) {
			for (const r of bySid.get(w.sid) ?? []) {
				if (r.ts < w.start || r.ts >= w.end || used.has(r)) continue;
				used.add(r);
				const t =
					Math.floor(r.ts / REQUEST_SPARK_BUCKET_MS) * REQUEST_SPARK_BUCKET_MS;
				const p = buckets.get(t) ?? { t, fresh: 0, cached: 0, out: 0 };
				p.fresh += r.inTok;
				p.cached += r.cacheR + r.cacheC;
				p.out += r.outTok;
				buckets.set(t, p);
			}
		}
		if (buckets.size)
			out.set(
				work,
				[...buckets.values()].sort((a, b) => a.t - b.t).slice(-cap),
			);
	}
	return out;
}

/** W776 attribution lookback: laneSpendRows never scans the whole ledger —
 *  spend older than this never matches a live claim window (a claim older
 *  than the lookback still attributes from its window onward; tokens before
 *  the cut are unattributed by design, the ledger is not a replay surface). */
export const ATTRIBUTION_LOOKBACK_MS = 30 * 86_400_000;

/** W776 — per-item attribution bundle: buckle spend (fresh/cached/output
 *  tokens + requests per model class) joined to event-bus wall/agent time.
 *  Composes the W635 join (itemSpend ⋈ claimWindows) with the W15 timing
 *  replay (workTiming). Fails soft: a missing/unreadable ledger yields zero
 *  spend with real wall time — metrics never blocks on the gateway. */
export interface ItemAttribution {
	work: string;
	fresh: number; // non-cache prompt tokens (in)
	cached: number; // cacheR + cacheC
	out: number;
	requests: number;
	wallMs: number; // first claim → last event (W15)
	agentMs: number; // Σ closed claim segments (W15)
	effort: string | null; // W909: lane effort level from the work.done payload
	/** W943.1: attributed spend includes cache-blind-era buckets — CACHE is
	 *  a floor for such items (docs/decant-crosscheck-2026-10-19.md). */
	blindCache: boolean;
	groups: Record<string, GroupSpend>;
}

/** The W776 attribution for one project's items, keyed by item id.
 *  W682: `pre` carries one preloaded claim-replay event scan (all projects)
 *  so a multi-project caller pays ONE bus read instead of two per project. */
export function itemAttribution(
	db: Database,
	project: string,
	nowMs = Date.now(),
	ledger: string | null = resolveBuckleDb(),
	pre?: TimingEventRow[],
): Map<string, ItemAttribution> {
	const { windows } = claimWindows(db, project, nowMs, pre);
	const timing = new Map(
		workTiming(db, project, nowMs, pre).map((t) => [t.work, t]),
	);
	const fromBucket = `${new Date(nowMs - ATTRIBUTION_LOOKBACK_MS).toISOString().slice(0, 13)}:00`;
	let rows: LaneSpendRow[] = [];
	try {
		rows = ledger ? laneSpendRows(ledger, fromBucket) : [];
	} catch {
		rows = []; // unreadable ledger — fail-soft (coord fleet parity)
	}
	const spend = itemSpend(rows, windows);
	const out = new Map<string, ItemAttribution>();
	const works = new Set<string>([...windows.keys(), ...timing.keys()]);
	for (const work of works) {
		const t = timing.get(work);
		const s = spend.get(work);
		// W1070 fallback: session-subagent work leaves no router_usage rows (no
		// per-lane key) — when the ledger attributes nothing, the closing
		// session's self-reported spend (work.done payload, lib/lane-done-spend.ts)
		// stands in so TOKENS/CACHE/MODEL don't dash out.
		const ds =
			(s?.in ?? 0) + (s?.cacheR ?? 0) + (s?.cacheC ?? 0) + (s?.out ?? 0) <= 0
				? t?.spend
				: undefined;
		out.set(work, {
			work,
			fresh: ds ? ds.fresh : (s?.in ?? 0),
			cached: ds ? ds.cached : (s?.cacheR ?? 0) + (s?.cacheC ?? 0),
			out: ds ? ds.out : (s?.out ?? 0),
			requests: s?.requests ?? 0,
			wallMs: t?.wallMs ?? 0,
			agentMs: t?.agentMs ?? 0,
			effort: t?.effort ?? null,
			blindCache:
				(s?.firstBucket != null && s.firstBucket < cacheEraFixBucket()) ||
				false,
			groups: ds
				? ds.model
					? {
							[ds.model]: {
								in: ds.fresh,
								out: ds.out,
								cacheR: ds.cached,
								cacheC: 0,
								requests: 0,
							},
						}
					: {}
				: Object.fromEntries(s?.groups ?? []),
		});
	}
	return out;
}

/** W776 — one-line human render for one item's attribution (work show).
 *  Empty string for an all-zero attribution: no noise on clean items. */
export function renderAttribution(a: ItemAttribution): string {
	if (a.fresh + a.cached + a.out === 0 && a.requests === 0 && !a.wallMs)
		return "";
	const total = (g: GroupSpend): number => g.in + g.out + g.cacheR + g.cacheC;
	const k = (n: number): string =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e4
				? `${Math.round(n / 1e3)}k`
				: `${n}`;
	const dur = (ms: number): string => {
		const m = Math.round(ms / 60_000);
		return m >= 60
			? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
			: `${m}m`;
	};
	const groups = Object.entries(a.groups)
		.filter(([, g]) => total(g) > 0)
		.sort((x, y) => total(y[1]) - total(x[1]))
		.slice(0, 3)
		.map(([g, v]) => `${g} ${k(total(v))}`)
		.join(", ");
	return `fresh ${k(a.fresh)} · cached ${k(a.cached)} · out ${k(a.out)} · ${a.requests} req · wall ${dur(a.wallMs)} (agent ${dur(a.agentMs)})${groups ? ` · ${groups}` : ""}`;
}
