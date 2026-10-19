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
	groups: Map<string, GroupSpend>;
}

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
	const bySid = new Map<string, LaneSpendRow[]>();
	for (const r of rows) {
		const arr = bySid.get(r.sid);
		if (arr) arr.push(r);
		else bySid.set(r.sid, [r]);
	}
	const attributed = new Set<LaneSpendRow>();
	const out = new Map<string, ItemSpend>();
	for (const [work, ws] of windows) {
		const t: ItemSpend = {
			work,
			in: 0,
			out: 0,
			cacheR: 0,
			cacheC: 0,
			requests: 0,
			groups: new Map(),
		};
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
				t.in += r.inTok;
				t.out += r.outTok;
				t.cacheR += r.cacheR;
				t.cacheC += r.cacheC;
				t.requests += r.requests;
				const g =
					t.groups.get(r.group) ??
					({
						in: 0,
						out: 0,
						cacheR: 0,
						cacheC: 0,
						requests: 0,
					} as const);
				t.groups.set(r.group, {
					in: g.in + r.inTok,
					out: g.out + r.outTok,
					cacheR: g.cacheR + r.cacheR,
					cacheC: g.cacheC + r.cacheC,
					requests: g.requests + r.requests,
				});
				attributed.add(r);
			}
		}
		out.set(work, t);
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
	wallMs: number; // current claim cycle: first claim → last event (W15, W895)
	agentMs: number; // Σ current-cycle claim segments (W15, W895)
	firstClaimMs: number; // current cycle's first claim (0 = none — W895 reset)
	priorAgentMs: number; // kept agent time from released/superseded cycles
	priorCycles: number;
	priorSinceMs: number; // first claim of the earliest kept cycle (0 = none)
	running: boolean; // open claim segment — the stale-clock guard keys on it
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
		out.set(work, {
			work,
			fresh: s?.in ?? 0,
			cached: (s?.cacheR ?? 0) + (s?.cacheC ?? 0),
			out: s?.out ?? 0,
			requests: s?.requests ?? 0,
			wallMs: t?.wallMs ?? 0,
			agentMs: t?.agentMs ?? 0,
			firstClaimMs: t?.firstClaim ?? 0,
			priorAgentMs: t?.priorAgentMs ?? 0,
			priorCycles: t?.priorCycles ?? 0,
			priorSinceMs: t?.priorSinceMs ?? 0,
			running: t?.running ?? false,
			groups: Object.fromEntries(s?.groups ?? []),
		});
	}
	return out;
}

/** W895 stale-clock guard: agent time past this on a non-running item is
 *  ghost-clock residue (or a genuinely ancient segment) — rendered as
 *  'stale (pre-<date>)', never raw hours. */
export const STALE_AGENT_MS = 7 * 86_400_000;

/** W776 — one-line human render for one item's attribution (work show).
 *  Empty string for an all-zero attribution: no noise on clean items.
 *  W895: on a non-running item (no open claim), agent time over
 *  STALE_AGENT_MS renders 'stale (pre-<date>)', never raw hours, and the
 *  kept prior split renders bounded instead of as live clock time. */
export function renderAttribution(a: ItemAttribution): string {
	if (
		a.fresh + a.cached + a.out === 0 &&
		a.requests === 0 &&
		!a.wallMs &&
		!a.priorAgentMs
	)
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
	const d = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
	const stale = (ms: number, since: number): string =>
		a.running || ms <= STALE_AGENT_MS ? dur(ms) : `stale (pre-${d(since)})`;
	const prior = (a: ItemAttribution): string => {
		if (!a.priorAgentMs) return "";
		if (!a.running && a.priorAgentMs > STALE_AGENT_MS)
			return ` · prior stale (pre-${d(a.priorSinceMs)})`;
		return ` · prior ${dur(a.priorAgentMs)} (${a.priorCycles} released cycle${a.priorCycles === 1 ? "" : "s"})`;
	};
	const groups = Object.entries(a.groups)
		.filter(([, g]) => total(g) > 0)
		.sort((x, y) => total(y[1]) - total(x[1]))
		.slice(0, 3)
		.map(([g, v]) => `${g} ${k(total(v))}`)
		.join(", ");
	return `fresh ${k(a.fresh)} · cached ${k(a.cached)} · out ${k(a.out)} · ${a.requests} req · wall ${dur(a.wallMs)} (agent ${stale(a.agentMs, a.firstClaimMs)})${prior(a)}${groups ? ` · ${groups}` : ""}`;
}
