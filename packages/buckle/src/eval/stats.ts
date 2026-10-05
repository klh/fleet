// src/eval/stats.ts — the power + decision layer (lesson.eval-power-discipline):
// per-shape accuracy with Wilson 95% intervals, exact McNemar on the paired
// discordant pairs, and the owner abstain rule — overlapping arm intervals →
// the eval abstains on quality and hands the call to cost per resolved task.
import type { Shape, TaskResult } from "./types.ts";

export const Z95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number): [number, number] {
	if (n <= 0) return [0, 1];
	const p = k / n;
	const z2 = Z95 * Z95;
	const d = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / d;
	const half = (Z95 / d) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Exact two-sided binomial test p-value under p=0.5 (McNemar discordants). */
export function binomTwoSidedP(k: number, n: number): number {
	if (n <= 0) return 1;
	let cdf = 0;
	for (let i = 0; i <= k; i++) cdf += binomPmf(i, n);
	const tail = Math.min(cdf, 1 - cdf + binomPmf(k, n));
	return Math.min(1, 2 * tail);
}

function binomPmf(k: number, n: number): number {
	let logp = 0;
	for (let i = 1; i <= k; i++) logp += Math.log(n - k + i) - Math.log(i);
	return Math.exp(logp + n * Math.log(0.5));
}

export interface ArmShape {
	ok: number;
	n: number;
	latency_p50_ms: number;
	tokens_in: number;
	tokens_out: number;
	cost_usd?: number;
}

export interface ShapeStats {
	shape: Shape;
	a: ArmShape;
	b: ArmShape;
	/** discordant pairs: a right / b wrong, a wrong / b right */
	n01: number;
	n10: number;
	mcnemar_p: number;
	diff: number;
	overlap: boolean;
	powered: boolean;
	min_n: number;
}

/** Minimum tasks per shape for ±7pt error bars (beri.net law). */
export const POWER_N = 130;

/** Aggregate one arm's per-task majority verdicts + token/latency sums. */
export function armShape(
	results: TaskResult[],
	taskIds: string[],
	repeats: number,
	latencies: number[],
): ArmShape {
	const byTask = new Map<string, number>();
	for (const r of results) {
		byTask.set(r.task_id, (byTask.get(r.task_id) ?? 0) + (r.ok ? 1 : 0));
	}
	const ok = taskIds.filter((id) => {
		const c = byTask.get(id) ?? 0;
		return c * 2 > repeats;
	}).length;
	const p50 = (xs: number[]): number => {
		if (xs.length === 0) return 0;
		const s = [...xs].sort((x, y) => x - y);
		return s[Math.min(s.length - 1, Math.floor(s.length / 2))] as number;
	};
	return {
		ok,
		n: taskIds.length,
		latency_p50_ms: Math.round(p50(latencies)),
		tokens_in: results.reduce((a, r) => a + r.tokens_in, 0),
		tokens_out: results.reduce((a, r) => a + r.tokens_out, 0),
	};
}

/** Pair a/b per-task verdicts on the shared list → ShapeStats. */
export function shapeStats(
	shape: Shape,
	a: ArmShape,
	b: ArmShape,
	pairs: { a: boolean; b: boolean }[],
): ShapeStats {
	const n01 = pairs.filter((p) => p.a && !p.b).length;
	const n10 = pairs.filter((p) => !p.a && p.b).length;
	const [loA, hiA] = wilson(a.ok, a.n);
	const [loB, hiB] = wilson(b.ok, b.n);
	const diff = (a.ok - b.ok) / Math.max(1, a.n);
	return {
		shape,
		a,
		b,
		n01,
		n10,
		mcnemar_p: binomTwoSidedP(Math.min(n01, n10), n01 + n10),
		diff,
		overlap: loA <= hiB && loB <= hiA,
		powered: a.n >= POWER_N,
		min_n: Math.min(a.n, b.n),
	};
}

export interface Verdict {
	verdict: "a" | "b" | "abstain";
	decided_by: "quality" | "cost" | "none";
	note: string;
}

/** Owner abstain rule (lesson.eval-power-discipline): overlapping arm Wilson
 *  intervals = tie → cost per resolved task decides; no prices = honest
 *  abstention. Non-overlap → the higher-accuracy arm wins on quality. */
export function decideShape(
	s: ShapeStats,
	costPerResolved?: { a?: number; b?: number },
): Verdict {
	const accA = s.a.ok / Math.max(1, s.a.n);
	const accB = s.b.ok / Math.max(1, s.b.n);
	if (!s.overlap) {
		const w = accA > accB ? "a" : "b";
		return {
			verdict: w,
			decided_by: "quality",
			note: `no interval overlap — ${w} by accuracy ${(Math.max(accA, accB) * 100).toFixed(1)}% vs ${(Math.min(accA, accB) * 100).toFixed(1)}%`,
		};
	}
	const ca = costPerResolved?.a;
	const cb = costPerResolved?.b;
	if (ca !== undefined && cb !== undefined && ca !== cb) {
		const w = ca < cb ? "a" : "b";
		return {
			verdict: w,
			decided_by: "cost",
			note: `quality tie — ${w} by cost per resolved task ($${(w === "a" ? ca : cb).toFixed(6)} vs $${(w === "a" ? cb : ca).toFixed(6)})`,
		};
	}
	return {
		verdict: "abstain",
		decided_by: "none",
		note: "quality tie and no cost inputs — eval abstains; rerun with prices to decide",
	};
}
