// hooks/lib/usage/cache-drilldown.ts — W826: drillable cache-efficiency report over
// the buckle ledger. The /usage dashboard aggregates tokens; this lib answers
// the owner's clone-reuse question: which lanes actually WARM their provider
// cache, which requests busted it, and why (heuristics, labeled as such).
// Sources (resolveBuckleDb spoke layout, fail-soft like lane-spend.ts):
//   route_audit  — per-request rows: ts, lane, actor(key id), model, status,
//                  duration, cache_r/cache_c (W457), dialect, hop
//   router_usage ⋈ api_keys — per-lane token/cost totals (hour buckets)
// Warm-rate = share of requests with cache_r > 0. Cost index = token-weighted
// relative spend proxy (no dollar pricing exists in the stack; weights are
// constants here, labeled "cost index", never rendered as dollars).
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolveBuckleDb } from "../lanes/lane-spend.ts";

/** anthropic-style cache TTL: a cold request this long after the last warm
 *  one is classified expiry, not drift. Heuristic boundary, documented. */
export const CACHE_TTL_MS = 5 * 60_000;
/** A cache write this big means a huge non-cached prefix rode the request —
 *  the lane's system prompt/tools should be prefix-stable instead. */
export const OVERSIZED_WRITE_TOK = 50_000;

/** Relative spend weights for the cost index (fresh/out/cached ratios). */
export const COST_WEIGHTS = {
	in: 1,
	out: 5,
	cacheR: 0.1,
	cacheC: 1.25,
} as const;

export const costIndex = (t: {
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
}): number =>
	t.in * COST_WEIGHTS.in +
	t.out * COST_WEIGHTS.out +
	t.cacheR * COST_WEIGHTS.cacheR +
	t.cacheC * COST_WEIGHTS.cacheC;

export interface BustReason {
	reason: string;
	count: number;
}

type Tok = { in: number; out: number; cacheR: number; cacheC: number };

/** One heuristic-input row: what bustReasons reads per request. */
type HeurRow = {
	tsMs: number;
	model: string;
	cacheR: number;
	cacheC: number;
	dialect: string;
};

/** Per-lane summary row: aggregates + heuristic bust reasons. */
export interface LaneDrill {
	lane: string;
	requests: number;
	warm: number;
	warmRate: number; // 0..1
	cacheR: number;
	cacheC: number;
	tokens: number; // in+out+cacheR+cacheC (router_usage window total)
	costIndex: number;
	models: string[];
	reasons: BustReason[];
}

export interface DrilldownReport {
	/** false = no readable ledger — views degrade honestly */
	available: boolean;
	window: { from: string; to: string; days: number };
	fleet: {
		requests: number;
		warm: number;
		warmRate: number;
		tokens: number;
		costIndex: number;
	};
	lanes: LaneDrill[];
	models: string[];
}

/** One request row (route_audit) for the lane drilldown. */
export interface DrillRequestRow {
	rid: string;
	ts: string;
	lane: string;
	model: string;
	status: number;
	ok: number;
	durationMs: number;
	cacheR: number;
	cacheC: number;
	decision: string;
	hop: string;
	err: string | null;
}

export interface DrillRequestPage {
	available: boolean;
	lane: string;
	rows: DrillRequestRow[];
	total: number;
	truncated: boolean;
	reasons: BustReason[];
}

export type DrillSort =
	| "warm-rate"
	| "cache-miss"
	| "tokens"
	| "cost"
	| "requests";

const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

const winOf = (
	opts: { days?: number; from?: string; to?: string },
	nowMs: number,
): { from: string; to: string; days: number } => {
	const to = opts.to ?? new Date(nowMs).toISOString();
	const days = Math.min(90, Math.max(1, opts.days ?? 7));
	const from =
		opts.from ?? new Date(Date.parse(to) - days * 86_400_000).toISOString();
	return { from, to, days };
};

/** Open the ledger readonly; null when missing/unopenable (fail-soft). */
function openLedger(ledgerPath: string | null): Database | null {
	if (!ledgerPath) return null;
	try {
		return new Database(ledgerPath, { readonly: true });
	} catch {
		return null;
	}
}

/** Classify one request against its same-lane predecessor. The FIRST row of
 *  a lane is cold-start, never a bust — a lane's first request cannot bust
 *  anything. Returns null for warm rows. */
export function classify(
	prev: { model: string; cacheR: number; tsMs: number } | null,
	cur: { model: string; cacheR: number; tsMs: number },
): string | null {
	if (cur.cacheR > 0) return null; // warm — not a bust
	if (prev === null) return "cold-start";
	if (prev.model !== cur.model) return "model-hop";
	if (cur.tsMs - prev.tsMs > CACHE_TTL_MS) return "ttl-expiry";
	if (prev.cacheR > 0) return "prefix-drift";
	return "streak";
}

/** Heuristic cache-bust reasons for one lane from its ts-ordered rows:
 *  prefix-drift = warm→cold inside one TTL on one model; model-hop = cold
 *  row whose predecessor rode another model; ttl-expiry = cold >TTL after
 *  the last request; streak = continuation of a cold run; oversized-write =
 *  big cache_c writes; dialect-flip = consecutive dialect changes. */
export function bustReasons(
	rows: Array<{
		tsMs: number;
		model: string;
		cacheR: number;
		cacheC: number;
		dialect: string;
	}>,
): BustReason[] {
	const counts = new Map<string, number>();
	const bump = (r: string): void => counts.set(r, (counts.get(r) ?? 0) + 1);
	let prev: { model: string; cacheR: number; tsMs: number } | null = null;
	let prevDialect = "";
	for (const r of rows) {
		const why = classify(prev, r);
		if (why !== null && why !== "cold-start") bump(why);
		if (r.cacheC >= OVERSIZED_WRITE_TOK) bump("oversized-write");
		if (prevDialect !== "" && r.dialect !== prevDialect) bump("dialect-flip");
		prevDialect = r.dialect;
		// prev = the LAST REQUEST (always advances). Comparing each cold row
		// against a stale anchor mislabeled long cold runs with phantom
		// ttl-expiries every ~TTL; continuation reads against the previous
		// request, and idle gaps between true requests are the expiry signal.
		prev = { model: r.model, cacheR: r.cacheR, tsMs: r.tsMs };
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([reason, count]) => ({ reason, count }));
}

/** Per-lane token totals (router_usage ⋈ api_keys; name = sid = lane slug,
 *  unmatched keys keep their raw key id). Buckets compare lexicographically
 *  against the ISO window. Pre-router_usage ledgers yield honest zeros. */
function laneTokens(db: Database, from: string, to: string): Map<string, Tok> {
	const out = new Map<string, Tok>();
	let rows: Array<Record<string, unknown>> = [];
	try {
		rows = db
			.query(
				"SELECT COALESCE(ak.name, ru.key) AS lane, SUM(ru.in_tok) i, SUM(ru.out_tok) o, SUM(ru.cache_r) cr, SUM(ru.cache_c) cc FROM router_usage ru LEFT JOIN api_keys ak ON ak.key_id = ru.key WHERE ru.hour_bucket >= ? AND ru.hour_bucket <= ? GROUP BY COALESCE(ak.name, ru.key)",
			)
			.all(`${from.slice(0, 13)}:00`, `${to.slice(0, 13)}:59`) as Array<
			Record<string, unknown>
		>;
	} catch {
		return out;
	}
	for (const r of rows)
		out.set(String(r.lane), {
			in: num(r.i),
			out: num(r.o),
			cacheR: num(r.cr),
			cacheC: num(r.cc),
		});
	return out;
}

/** ts-ordered request rows per lane (the heuristic input). */
function rowsByLane(
	db: Database,
	from: string,
	to: string,
	model: string,
): Map<string, HeurRow[]> {
	const out = new Map<string, HeurRow[]>();
	const modelFrag = model ? " AND target_model = ?" : "";
	const rows = db
		.query(
			`SELECT lane, ts, target_model, cache_r, cache_c, dialect FROM route_audit WHERE ts >= ? AND ts <= ?${modelFrag} ORDER BY ts`,
		)
		.all(...(model ? [from, to, model] : [from, to])) as Array<
		Record<string, unknown>
	>;
	for (const r of rows) {
		const lane = String(r.lane ?? "");
		const arr = out.get(lane) ?? [];
		arr.push({
			tsMs: Date.parse(String(r.ts)),
			model: String(r.target_model ?? ""),
			cacheR: num(r.cache_r),
			cacheC: num(r.cache_c),
			dialect: String(r.dialect ?? ""),
		});
		out.set(lane, arr);
	}
	return out;
}

function sortLanes(lanes: LaneDrill[], sort: DrillSort): LaneDrill[] {
	const missRatio = (l: LaneDrill): number =>
		l.requests > 0 ? 1 - l.warmRate : 0;
	const cmp: Record<DrillSort, (a: LaneDrill, b: LaneDrill) => number> = {
		"warm-rate": (a, b) => a.warmRate - b.warmRate, // worst first
		"cache-miss": (a, b) => missRatio(b) - missRatio(a),
		tokens: (a, b) => b.tokens - a.tokens,
		cost: (a, b) => b.costIndex - a.costIndex,
		requests: (a, b) => b.requests - a.requests,
	};
	return [...lanes].sort(cmp[sort]);
}

/** Build the drilldown report. Pure function of (ledger, opts, nowMs) — the
 *  board route and the mining runner share it. Fails soft on every ledger
 *  problem: an unreadable db reports available:false, never throws. */
export function drilldownReport(
	ledgerPath: string | null,
	opts: {
		days?: number;
		from?: string;
		to?: string;
		model?: string;
		sort?: DrillSort;
	},
	nowMs = Date.now(),
): DrilldownReport {
	const win = winOf(opts, nowMs);
	const fail = (): DrilldownReport => ({
		available: false,
		window: win,
		fleet: { requests: 0, warm: 0, warmRate: 0, tokens: 0, costIndex: 0 },
		lanes: [],
		models: [],
	});
	if (!ledgerPath) return fail();
	const db = openLedger(ledgerPath);
	if (!db) return fail();
	try {
		return buildReport(db, win, opts);
	} catch {
		return fail();
	} finally {
		db.close();
	}
}

function laneDrillOf(
	a: Record<string, unknown>,
	toks: Map<string, Tok>,
	heur: Map<string, HeurRow[]>,
): LaneDrill {
	const lane = String(a.lane ?? "");
	const requests = num(a.n);
	const warm = num(a.warm);
	const t = toks.get(lane) ?? { in: 0, out: 0, cacheR: 0, cacheC: 0 };
	const ci = costIndex(t);
	return {
		lane,
		requests,
		warm,
		warmRate: requests > 0 ? warm / requests : 0,
		cacheR: num(a.cr),
		cacheC: num(a.cc),
		tokens: t.in + t.out + t.cacheR + t.cacheC,
		costIndex: ci,
		models: [],
		reasons: bustReasons(heur.get(lane) ?? []),
	};
}

/** The report body — split out so drilldownReport stays fail-soft. */
function buildReport(
	db: Database,
	win: { from: string; to: string; days: number },
	opts: { model?: string; sort?: DrillSort },
): DrilldownReport {
	const aggRows = db
		.query(
			`SELECT lane, COUNT(*) n, SUM(cache_r > 0) warm, SUM(COALESCE(cache_r, 0)) cr, SUM(COALESCE(cache_c, 0)) cc FROM route_audit WHERE ts >= ? AND ts <= ?${opts.model ? " AND target_model = ?" : ""} GROUP BY lane`,
		)
		.all(win.from, win.to, ...bindsOf(opts)) as Array<Record<string, unknown>>;
	const toks = laneTokens(db, win.from, win.to);
	const heur = rowsByLane(db, win.from, win.to, opts.model ?? "");
	const lanes = aggRows.map((a) => laneDrillOf(a, toks, heur));
	const fleetReq = lanes.reduce((s, l) => s + l.requests, 0);
	const fleetWarm = lanes.reduce((s, l) => s + l.warm, 0);
	const facet = db
		.query(
			"SELECT DISTINCT target_model m FROM route_audit WHERE ts >= ? AND ts <= ? AND target_model != '' ORDER BY m",
		)
		.all(win.from, win.to) as Array<{ m: string }>;
	return {
		available: true,
		window: win,
		fleet: {
			requests: fleetReq,
			warm: fleetWarm,
			warmRate: fleetReq > 0 ? fleetWarm / fleetReq : 0,
			tokens: lanes.reduce((s, l) => s + l.tokens, 0),
			costIndex: lanes.reduce((s, l) => s + l.costIndex, 0),
		},
		lanes: sortLanes(lanes, opts.sort ?? "warm-rate"),
		models: facet.map((r) => String(r.m)),
	};
}

const REQUEST_COLS =
	"rid, ts, lane, COALESCE(target_model, '') model, COALESCE(status, 0) status, COALESCE(ok, 0) ok, COALESCE(duration_ms, 0) durationMs, COALESCE(cache_r, 0) cacheR, COALESCE(cache_c, 0) cacheC, decision, COALESCE(hop, '') hop, err";

function bindsOf(opts: { model?: string }): unknown[] {
	return opts.model ? [opts.model] : [];
}

/** One lane's request rows, newest first — the second disclosure level.
 *  missOnly cuts to cache_r = 0 rows (the bust list). Capped at `limit`
 *  (1..500, default 200); `truncated` says when the cap bit. */
export function laneRequests(
	ledgerPath: string | null,
	opts: {
		lane: string;
		days?: number;
		from?: string;
		to?: string;
		model?: string;
		missOnly?: boolean;
		limit?: number;
	},
	nowMs = Date.now(),
): DrillRequestPage {
	const win = winOf(opts, nowMs);
	const fail = (): DrillRequestPage => ({
		available: false,
		lane: opts.lane,
		rows: [],
		total: 0,
		truncated: false,
		reasons: [],
	});
	const db = openLedger(ledgerPath);
	if (!db) return fail();
	try {
		return queryRows(db, win, opts);
	} catch {
		return fail();
	} finally {
		db.close();
	}
}

function queryRows(
	db: Database,
	win: { from: string; to: string; days: number },
	opts: { lane: string; model?: string; missOnly?: boolean; limit?: number },
): DrillRequestPage {
	const conds = ["ts >= ?", "ts <= ?", "lane = ?"];
	const binds: unknown[] = [win.from, win.to, opts.lane];
	if (opts.model) {
		conds.push("target_model = ?");
		binds.push(opts.model);
	}
	if (opts.missOnly) conds.push("COALESCE(cache_r, 0) = 0");
	const where = conds.join(" AND ");
	const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
	const total = (
		db
			.query(`SELECT COUNT(*) n FROM route_audit WHERE ${where}`)
			.get(...binds) as { n: number }
	).n;
	const rows = db
		.query(
			`SELECT ${REQUEST_COLS} FROM route_audit WHERE ${where} ORDER BY ts DESC LIMIT ${limit}`,
		)
		.all(...binds) as unknown as DrillRequestRow[];
	const heur =
		rowsByLane(db, win.from, win.to, opts.model ?? "").get(opts.lane) ?? [];
	return {
		available: true,
		lane: opts.lane,
		rows,
		total,
		truncated: total > rows.length,
		reasons: bustReasons(heur),
	};
}

/** Pulse-facing fleet warm-rate: 7d window, fail-soft null (a missing
 *  ledger never blocks the heartbeat — the pulse just omits the line). */
export function fleetWarm(
	ledgerPath: string | null = resolveBuckleDb(),
	opts: { days?: number; nowMs?: number } = {},
): FleetWarm | null {
	const r = drilldownReport(
		ledgerPath,
		{ days: opts.days ?? 7 },
		opts.nowMs ?? Date.now(),
	);
	if (!r.available || r.fleet.requests === 0) return null;
	return {
		rate: r.fleet.warmRate,
		requests: r.fleet.requests,
		worst: r.lanes[0] ?? null,
	};
}

export interface FleetWarm {
	rate: number;
	requests: number;
	worst: LaneDrill | null;
}

/** One ranked offender from the weekly mining pass. */
export interface MiningOffender {
	lane: string;
	requests: number;
	warmRate: number;
	tokens: number;
	topReason: string;
}

export interface MiningArtifact {
	at: number;
	days: number;
	offenders: MiningOffender[];
}

export const miningArtifactPath = (): string =>
	process.env.KLH_MINING_STATE ??
	`${(process.env.HOME ?? "").replace(/\/$/, "")}/.cache/claude-governor/usage-mining.json`;

/** Read the mining artifact as terse pulse lines; [] when absent/stale/
 *  corrupt (a failed mining week never litters the digest forever). */
export function readMiningLines(
	nowMs = Date.now(),
	maxAgeMs = 8 * 86_400_000,
	path = miningArtifactPath(),
): string[] {
	let a: MiningArtifact;
	try {
		a = JSON.parse(readFileSync(path, "utf8")) as MiningArtifact;
	} catch {
		return [];
	}
	if (typeof a.at !== "number" || nowMs - a.at > maxAgeMs) return [];
	const pcts = (x: number): string => `${(x * 100).toFixed(1)}%`;
	return a.offenders
		.slice(0, 3)
		.map(
			(o) =>
				`cache offender ${pcts(o.warmRate)} warm · ${o.lane} (${o.requests} req/7d, ${o.topReason})`,
		);
}
