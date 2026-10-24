// hooks/lib/usage/cache-telemetry.ts — W825.2: weekly cache-telemetry mining that
// feeds the W822 pulse digest. Source: buckle's W458.4 per-lane cache log
// (${BUCKLE_DB}.lane-cache.jsonl; BUCKLE_LANE_CACHE_LOG overrides). Mines
// per-lane warm-cache ratios, ranks cold high-spend lanes (top offenders),
// and clusters same-boundary lanes into clone-reuse recommendations. The
// report lands as JSON where the W822 pulse reads it as a section. Leaf-pure:
// the NDJSON row is the contract (structural type, no buckle import), every
// source injectable for tests.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Structural mirror of buckle's LaneCacheRow (W458.4) — the NDJSON line is
 *  the contract; no cross-package import. */
export type CacheRow = {
	lane: string;
	task: string;
	boundary: {
		provider: string;
		tenant: string;
		region: string;
		model: string;
	};
	usage: { in_tok: number; out_tok: number; cache_r: number; cache_c: number };
	requests: number;
	wallMs: number;
	at: string;
};

export interface LaneWarmStats {
	lane: string;
	requests: number;
	/** in_tok + cache_r + cache_c — everything the lane pushed as input */
	inputTok: number;
	/** cache_r / inputTok — the per-lane warm-cache ratio (0 when no input) */
	warmRatio: number;
	/** in_tok — input that rode no cache (the miss spend) */
	freshTok: number;
	/** cache_c — cache-write spend (the seed cost of warm future requests) */
	cacheWriteTok: number;
}

export interface CacheReport {
	generatedAt: string;
	/** parsable `at` span of the mined rows (null when none parsable) */
	window: { from: string | null; to: string | null };
	lanes: LaneWarmStats[];
	/** cold high-spend lanes, ranked by fresh tokens */
	offenders: Array<{ lane: string; freshTok: number; warmRatio: number }>;
	/** same-boundary lanes that should ride the warm lane's prefix/clone */
	reuse: Array<{ boundary: string; template: string; cold: string[] }>;
}

const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** NDJSON lane-cache log → rows; corrupt lines are skipped, never fatal
 *  (a damaged log reports from what survives, like buckle's own reader). */
export function readLaneCacheLog(file: string): CacheRow[] {
	if (!existsSync(file)) return [];
	const rows: CacheRow[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const raw = JSON.parse(line) as Record<string, unknown>;
			const lane = str(raw.lane);
			if (lane === "") continue;
			const b = (raw.boundary ?? {}) as Record<string, unknown>;
			const u = (raw.usage ?? {}) as Record<string, unknown>;
			rows.push({
				lane,
				task: str(raw.task),
				boundary: {
					provider: str(b.provider),
					tenant: str(b.tenant),
					region: str(b.region),
					model: str(b.model),
				},
				usage: {
					in_tok: num(u.in_tok),
					out_tok: num(u.out_tok),
					cache_r: num(u.cache_r),
					cache_c: num(u.cache_c),
				},
				requests: num(raw.requests),
				wallMs: num(raw.wallMs),
				at: str(raw.at),
			});
		} catch {
			// damaged line — skipped, never fabricated
		}
	}
	return rows;
}

/** Rows at/after fromMs; a row without a parsable `at` stays — absence of
 *  evidence is not age. */
export function rowsInWindow(rows: CacheRow[], fromMs: number): CacheRow[] {
	return rows.filter((r) => {
		const t = Date.parse(r.at);
		return Number.isNaN(t) ? true : t >= fromMs;
	});
}

const boundaryKeyOf = (b: CacheRow["boundary"]): string =>
	[b.provider, b.tenant, b.region, b.model].join("|");

export interface MineOpts {
	/** sample floor: lanes under this many requests get no verdict */
	minRequests?: number;
	/** a lane is cold below this warm ratio */
	offenderThreshold?: number;
	/** reuse fires when a cold lane trails the template by this spread */
	reuseSpread?: number;
	/** max offenders kept */
	topN?: number;
}

/** Per-lane cache split over the given rows, ranked by fresh-token spend
 *  (the offender cut's rank; ties by lane name keep it deterministic). */
export function laneWarmStats(rows: CacheRow[]): LaneWarmStats[] {
	const byLane = new Map<string, LaneWarmStats>();
	for (const r of rows) {
		const acc = byLane.get(r.lane) ?? {
			lane: r.lane,
			requests: 0,
			inputTok: 0,
			warmRatio: 0,
			freshTok: 0,
			cacheWriteTok: 0,
		};
		const inTok = num(r.usage.in_tok);
		const read = num(r.usage.cache_r);
		const wrote = num(r.usage.cache_c);
		acc.requests += num(r.requests);
		acc.freshTok += inTok;
		acc.cacheWriteTok += wrote;
		acc.inputTok += inTok + read + wrote;
		acc.warmRatio =
			acc.inputTok === 0
				? 0
				: (acc.inputTok - acc.freshTok - acc.cacheWriteTok) / acc.inputTok;
		byLane.set(r.lane, acc);
	}
	return [...byLane.values()].sort(
		(a, b) => b.freshTok - a.freshTok || a.lane.localeCompare(b.lane),
	);
}

function offendersOf(
	eligible: LaneWarmStats[],
	threshold: number,
	topN: number,
): CacheReport["offenders"] {
	return eligible
		.filter((l) => l.warmRatio < threshold && l.freshTok > 0)
		.slice(0, topN)
		.map((l) => ({
			lane: l.lane,
			freshTok: l.freshTok,
			warmRatio: l.warmRatio,
		}));
}

function reuseClustersOf(
	rows: CacheRow[],
	eligible: LaneWarmStats[],
	spread: number,
): CacheReport["reuse"] {
	const byBoundary = new Map<string, LaneWarmStats[]>();
	for (const l of eligible) {
		const row = rows.find((r) => r.lane === l.lane);
		const key = boundaryKeyOf(
			row?.boundary ?? { provider: "", tenant: "", region: "", model: "" },
		);
		const group = byBoundary.get(key) ?? [];
		group.push(l);
		byBoundary.set(key, group);
	}
	const reuse: CacheReport["reuse"] = [];
	for (const [key, group] of byBoundary) {
		if (group.length < 2) continue;
		const template = [...group].sort(
			(a, b) => b.warmRatio - a.warmRatio || b.requests - a.requests,
		)[0];
		if (template === undefined) continue;
		const cold = group
			.filter(
				(l) =>
					l.lane !== template.lane &&
					l.warmRatio <= template.warmRatio - spread,
			)
			.map((l) => l.lane)
			.sort();
		if (cold.length > 0)
			reuse.push({ boundary: key, template: template.lane, cold });
	}
	return reuse.sort(
		(a, b) =>
			b.cold.length - a.cold.length || a.boundary.localeCompare(b.boundary),
	);
}

function windowOf(rows: CacheRow[]): CacheReport["window"] {
	const times = rows
		.map((r) => Date.parse(r.at))
		.filter((t) => !Number.isNaN(t))
		.sort((a, b) => a - b);
	if (times.length === 0) return { from: null, to: null };
	const first = times[0];
	const last = times[times.length - 1];
	return {
		from: new Date(first ?? 0).toISOString(),
		to: new Date(last ?? 0).toISOString(),
	};
}

/** Mine the weekly report: per-lane warm ratios, top offenders (cold lanes
 *  ranked by fresh spend, sample floor applied), and clone-reuse clusters
 *  (lanes sharing one boundary where a cold lane trails a warm template by
 *  the spread). Deterministic: stable sorts, ties by lane/boundary name. */
export function mineCacheTelemetry(
	rows: CacheRow[],
	opts: MineOpts = {},
): CacheReport {
	const minRequests = opts.minRequests ?? 5;
	const threshold = opts.offenderThreshold ?? 0.5;
	const spread = opts.reuseSpread ?? 0.3;
	const topN = opts.topN ?? 5;
	const stats = laneWarmStats(rows);
	const eligible = stats.filter((l) => l.requests >= minRequests);
	return {
		generatedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
		window: windowOf(rows),
		lanes: stats,
		offenders: offendersOf(eligible, threshold, topN),
		reuse: reuseClustersOf(rows, eligible, spread),
	};
}

/** Where the weekly report lands (the W822 pulse reads it here). */
export const cacheReportPath = (): string =>
	process.env.KLH_CACHE_TELEMETRY ??
	join(homedir(), ".cache", "claude-governor", "cache-telemetry.json");

/** Report file → parsed report; missing/corrupt = no section, never fatal. */
export function readCacheReport(path: string): CacheReport | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheReport>;
		if (!Array.isArray(raw.lanes)) return null;
		return {
			generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
			window: {
				from: raw.window?.from ?? null,
				to: raw.window?.to ?? null,
			},
			lanes: raw.lanes,
			offenders: Array.isArray(raw.offenders) ? raw.offenders : [],
			reuse: Array.isArray(raw.reuse) ? raw.reuse : [],
		};
	} catch {
		return null;
	}
}

const pctOf = (ratio: number): number => Math.round(ratio * 100);
const tokOf = (n: number): string => n.toLocaleString("en-US");

const ageLabel = (iso: string, nowMs: number): string => {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "unknown age";
	const s = Math.max(0, Math.floor((nowMs - t) / 1000));
	if (s < 90) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
};

/** Pulse section lines for one report; null = nothing to say (no data). */
export function cachePulseSection(
	report: CacheReport | null,
	now: () => number = Date.now,
): string[] | null {
	if (report === null || report.lanes.length === 0) return null;
	const out: string[] = [
		`cache telemetry (mined ${ageLabel(report.generatedAt, now())} ago):`,
	];
	for (const o of report.offenders.slice(0, 3))
		out.push(
			`  ${o.lane} cold — ${pctOf(o.warmRatio)}% warm, fresh ${tokOf(o.freshTok)} tok`,
		);
	for (const r of report.reuse.slice(0, 2))
		out.push(
			`  reuse: ${r.cold.join(", ")} should ride ${r.template}'s prefix`,
		);
	return out;
}

/** Lane-cache log discovery: explicit pin wins (BUCKLE_LANE_CACHE_LOG, then
 *  SUSPENDERS_BUCKLE_DB / BUCKLE_DB + ".lane-cache.jsonl"), then the Mac
 *  spoke's runtime home, else the repo siblings the quota-sweep db
 *  discovery trusts (klh repos sit side by side). */
export function defaultLaneCacheLog(
	projectRoots: string[] = [],
): string | null {
	const laneEnv = process.env.BUCKLE_LANE_CACHE_LOG;
	if (laneEnv) return existsSync(laneEnv) ? laneEnv : null;
	const dbEnv = process.env.SUSPENDERS_BUCKLE_DB;
	const buckleDb = process.env.BUCKLE_DB;
	const candidates = [
		...(dbEnv !== undefined && dbEnv !== ""
			? [`${dbEnv}.lane-cache.jsonl`]
			: []),
		...(buckleDb !== undefined && buckleDb !== ""
			? [`${buckleDb}.lane-cache.jsonl`]
			: []),
		join(homedir(), ".claude", "local-llm", "buckle.db.lane-cache.jsonl"),
		...projectRoots.map((r) => `${r}/../buckle/buckle.db.lane-cache.jsonl`),
		new URL("../../buckle/buckle.db.lane-cache.jsonl", import.meta.url)
			.pathname,
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}
