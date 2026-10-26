// hooks/lib/usage/cache-sla.ts — W1139.1: rolling per-lane cache hit-share
// SLA evaluation over buckle's W458.4 lane-cache NDJSON (the same rows the
// W825.2 weekly mining reads). A lane BREACHES the cache-SLA when its
// rolling hit share (cache_r ÷ (in_tok + cache_r + cache_c)) over the
// window sits below the threshold with enough sample. Leaf-pure like
// cache-telemetry.ts: the NDJSON row is the contract (structural type), fs
// is injectable-side (readers fail soft — a damaged log reports from what
// survives, never fabricates).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CacheRow, rowsInWindow } from "./cache-telemetry.ts";

/** Per-lane rolling verdict. hitShare = cache_r ÷ (in_tok + cache_r +
 *  cache_c) over the window's rows — the same denominator cache-telemetry's
 *  warmRatio rides, so the two reports always agree on the math. */
export interface LaneSlaRow {
	lane: string;
	requests: number;
	/** in_tok + cache_r + cache_c over the window */
	inputTok: number;
	/** cache_r ÷ inputTok (0 when no input) */
	hitShare: number;
	/** sample floor met AND hitShare below the threshold */
	breaching: boolean;
}

export interface CacheSlaReport {
	generatedAt: string;
	windowMinutes: number;
	threshold: number;
	minRequests: number;
	/** every lane with window rows, worst hit share first */
	lanes: LaneSlaRow[];
	/** lane names that breached (sample floor met, below threshold) */
	breaches: string[];
}

export interface SlaOpts {
	windowMinutes?: number;
	threshold?: number;
	minRequests?: number;
	/** test seam */
	now?: () => number;
}

/** Per-lane rolling hit shares over the last windowMs of parsable rows.
 *  A row without a parsable `at` stays (absence of evidence is not age —
 *  rowsInWindow's rule). Worst first, ties by lane name. */
export function rollingHitShares(
	rows: CacheRow[],
	windowMs: number,
	nowMs: number,
): LaneSlaRow[] {
	const windowed = rowsInWindow(rows, nowMs - windowMs);
	const byLane = new Map<
		string,
		LaneSlaRow & { cacheRead: number }
	>();
	for (const r of windowed) {
		const acc = byLane.get(r.lane) ?? {
			lane: r.lane,
			requests: 0,
			inputTok: 0,
			cacheRead: 0,
			hitShare: 0,
			breaching: false,
		};
		acc.requests += r.requests;
		acc.inputTok += r.usage.in_tok + r.usage.cache_r + r.usage.cache_c;
		acc.cacheRead += r.usage.cache_r;
		byLane.set(r.lane, acc);
	}
	return [...byLane.values()]
		.map(({ cacheRead, ...rest }) => ({
			...rest,
			hitShare: rest.inputTok === 0 ? 0 : cacheRead / rest.inputTok,
		}))
		.sort(
		(a, b) => a.hitShare - b.hitShare || a.lane.localeCompare(b.lane),
	);
}

/** The SLA evaluation: breaches = lanes over the sample floor whose rolling
 *  hit share sits below the threshold. Deterministic; empty log → empty
 *  report (no data is never a breach). */
export function evaluateCacheSla(rows: CacheRow[], opts: SlaOpts = {}): CacheSlaReport {
	const windowMinutes = opts.windowMinutes ?? 60;
	const threshold = opts.threshold ?? 0.5;
	const minRequests = opts.minRequests ?? 5;
	const nowMs = (opts.now ?? Date.now)();
	const lanes = rollingHitShares(rows, windowMinutes * 60_000, nowMs);
	for (const l of lanes)
		l.breaching = l.requests >= minRequests && l.hitShare < threshold;
	return {
		generatedAt: new Date(nowMs).toISOString(),
		windowMinutes,
		threshold,
		minRequests,
		lanes,
		breaches: lanes.filter((l) => l.breaching).map((l) => l.lane),
	};
}

export type SlaBadgeLevel = "ok" | "breach" | "nodata";

/** Board badge derivation: ok when sample exists and nothing breaches,
 *  breach with the count, nodata when the log had no window rows. */
export function cacheSlaBadge(report: CacheSlaReport | null): {
	level: SlaBadgeLevel;
	text: string;
} {
	if (report === null || report.lanes.length === 0)
		return { level: "nodata", text: "cache-SLA: no data" };
	if (report.breaches.length === 0)
		return {
			level: "ok",
			text: `cache-SLA: ok (${String(report.lanes.length)} lane(s))`,
		};
	return {
		level: "breach",
		text: `cache-SLA: ${String(report.breaches.length)} breach(es) — ${report.breaches.join(", ")}`,
	};
}

/** Where the sweep's status JSON lands (the board face reads it here). */
export const cacheSlaStatusPath = (): string =>
	process.env.KLH_CACHE_SLA_STATUS ??
	join(homedir(), ".cache", "claude-governor", "cache-sla.json");

/** Status file → parsed report; missing/corrupt = null (a board badge never
 *  blocks the page on a missing sweep). */
export function readCacheSlaStatus(path: string): CacheSlaReport | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheSlaReport>;
		if (!Array.isArray(raw.lanes)) return null;
		return {
			generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
			windowMinutes: numOr(raw.windowMinutes, 60),
			threshold: numOr(raw.threshold, 0.5),
			minRequests: numOr(raw.minRequests, 5),
			lanes: raw.lanes,
			breaches: Array.isArray(raw.breaches) ? raw.breaches : [],
		};
	} catch {
		return null;
	}
}

const numOr = (v: unknown, fb: number): number =>
	typeof v === "number" && Number.isFinite(v) ? v : fb;
