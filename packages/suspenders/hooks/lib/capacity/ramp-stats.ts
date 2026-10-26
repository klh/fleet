// hooks/lib/capacity/ramp-stats.ts — W1713 pure measurement math: nearest-rank
// percentiles, per-step statistics (three SEPARATE concurrency counters:
// own in-flight, gateway-wide in-flight, distinct successful lane ids),
// the stop rules, and the per-route verdict. No I/O, no clock.
import type {
	InflightSample,
	OutcomeClass,
	RampRoute,
	RampWire,
	RequestRow,
	StopReason,
	StopRules,
	Usage,
} from "./ramp-types.ts";
import { OUTCOME_CLASSES } from "./ramp-types.ts";

/** Nearest-rank percentile over an ASCENDING array; null when empty. */
export function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

const mean = (xs: number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const peak = (xs: number[]): number | null =>
	xs.length === 0 ? null : Math.max(...xs);
const present = (xs: (number | null)[]): number[] =>
	xs.filter((x): x is number => x !== null);

export type StepUsage = Usage & { cacheHitShare: number | null };

export interface StepStats {
	route: string;
	model: string;
	wire: RampWire;
	concurrency: number;
	holdS: number;
	actualS: number;
	/** first successful start -> last successful finish (the sustained window) */
	okWindowS: number;
	sent: number;
	completed: number;
	ok: number;
	byClass: Record<OutcomeClass, number>;
	byCode: Record<string, number>;
	errPct: number;
	latencyMs: { p50: number | null; p95: number | null; max: number | null };
	latencyAllP95: number | null;
	okPerMin: number;
	retryAfterMaxS: number | null;
	usage: StepUsage;
	lanesTried: number;
	lanesOk: number;
	rpc: {
		ownPeak: number;
		ownMean: number | null;
		gatewayPeak: number | null;
		gatewayMean: number | null;
		gatewayOwnPeak: number | null;
		gatewayModelPeak: number | null;
		samples: number;
	};
}

export function emptyByClass(): Record<OutcomeClass, number> {
	const out = {} as Record<OutcomeClass, number>;
	for (const c of OUTCOME_CLASSES) out[c] = 0;
	return out;
}

export function sumUsage(rows: RequestRow[]): StepUsage {
	const u = { fresh: 0, cached: 0, cacheWrite: 0, out: 0 };
	for (const r of rows) {
		u.fresh += r.usage.fresh;
		u.cached += r.usage.cached;
		u.cacheWrite += r.usage.cacheWrite;
		u.out += r.usage.out;
	}
	const input = u.fresh + u.cached + u.cacheWrite;
	return { ...u, cacheHitShare: input > 0 ? u.cached / input : null };
}

export function summarizeStep(i: {
	route: RampRoute;
	concurrency: number;
	holdS: number;
	startMs: number;
	endMs: number;
	rows: RequestRow[];
	samples: InflightSample[];
	ownPeak: number;
}): StepStats {
	const done = i.rows.filter((r) => r.class !== "aborted");
	const oks = done.filter((r) => r.class === "ok");
	const byClass = emptyByClass();
	const byCode: Record<string, number> = {};
	for (const r of i.rows) {
		byClass[r.class] += 1;
		if (r.class === "ok") continue;
		const k = r.code ?? `http${String(r.status)}`;
		byCode[k] = (byCode[k] ?? 0) + 1;
	}
	const okMs = oks.map((r) => r.ms).sort((a, b) => a - b);
	const allMs = done.map((r) => r.ms).sort((a, b) => a - b);
	const actualS = Math.max(0, (i.endMs - i.startMs) / 1000);
	const okStart = Math.min(...oks.map((r) => r.startMs));
	const okEnd = Math.max(...oks.map((r) => r.startMs + r.ms));
	const retry = present(done.map((r) => r.retryAfterS));
	return {
		route: i.route.name,
		model: i.route.model,
		wire: i.route.wire,
		concurrency: i.concurrency,
		holdS: i.holdS,
		actualS,
		okWindowS: oks.length > 0 ? (okEnd - okStart) / 1000 : 0,
		sent: i.rows.length,
		completed: done.length,
		ok: oks.length,
		byClass,
		byCode,
		errPct:
			done.length > 0 ? ((done.length - oks.length) / done.length) * 100 : 0,
		latencyMs: {
			p50: percentile(okMs, 50),
			p95: percentile(okMs, 95),
			max: peak(okMs),
		},
		latencyAllP95: percentile(allMs, 95),
		okPerMin: actualS > 0 ? oks.length / (actualS / 60) : 0,
		retryAfterMaxS: peak(retry),
		usage: sumUsage(i.rows),
		lanesTried: new Set(i.rows.map((r) => r.lane)).size,
		lanesOk: new Set(oks.map((r) => r.lane)).size,
		rpc: {
			ownPeak: i.ownPeak,
			ownMean: mean(i.samples.map((s) => s.own)),
			gatewayPeak: peak(present(i.samples.map((s) => s.gateway))),
			gatewayMean: mean(present(i.samples.map((s) => s.gateway))),
			gatewayOwnPeak: peak(present(i.samples.map((s) => s.gatewayOwn))),
			gatewayModelPeak: peak(present(i.samples.map((s) => s.gatewayModel))),
			samples: i.samples.length,
		},
	};
}

/** First tripped rule wins; throttles (provider429 > local503 > local429)
 *  outrank the soft thresholds. null = the step was clean. */
export function evaluateStop(
	s: StepStats,
	rules: StopRules,
): StopReason | null {
	if (s.byClass.provider429 > 0) return "provider429";
	if (s.byClass.local503 > 0) return "local503";
	if (s.byClass.local429 > 0) return "local429";
	if (s.completed >= rules.minSamples && s.errPct > rules.maxErrPct)
		return "error_rate";
	if (
		s.completed >= rules.minSamples &&
		s.latencyMs.p95 !== null &&
		s.latencyMs.p95 > rules.maxP95Ms
	)
		return "p95_latency";
	return null;
}

export interface FirstBad {
	concurrency: number;
	reason: StopReason;
}

export interface RouteVerdict {
	route: string;
	stepsRun: number;
	/** highest concurrency whose step was clean — a LOWER BOUND, not a max */
	cleanMax: number | null;
	firstBad: FirstBad | null;
}

export function routeVerdict(
	route: string,
	steps: StepStats[],
	rules: StopRules,
): RouteVerdict {
	let cleanMax: number | null = null;
	let firstBad: FirstBad | null = null;
	for (const s of steps) {
		const reason = evaluateStop(s, { ...rules, minSamples: 1 });
		if (reason === null && s.ok > 0) cleanMax = s.concurrency;
		if (reason !== null && firstBad === null)
			firstBad = { concurrency: s.concurrency, reason };
	}
	return { route, stepsRun: steps.length, cleanMax, firstBad };
}
