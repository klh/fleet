// src/eval/report.ts — per-shape aggregation: paired majority verdicts →
// ShapeStats → Wilson bounds + cost per resolved → the owner abstain rule.
import { armShape, decideShape, shapeStats, wilson } from "./stats.ts";
import type { Arm, Shape, TaskResult } from "./types.ts";

export interface ShapeReport {
	shape: Shape;
	n: number;
	acc_a: number;
	lo_a: number;
	hi_a: number;
	acc_b: number;
	lo_b: number;
	hi_b: number;
	overlap: boolean;
	mcnemar_p: number;
	diff: number;
	lat_p50_a: number;
	lat_p50_b: number;
	per_resolved_a?: number;
	per_resolved_b?: number;
	powered: boolean;
	verdict: "a" | "b" | "abstain";
	decided_by: "quality" | "cost" | "none";
	note: string;
}

/** Majority verdict per task across repeats (tie → incorrect, strict). */
export function majority(
	rows: TaskResult[],
	ids: string[],
	repeats: number,
): boolean[] {
	const out: boolean[] = [];
	for (const id of ids) {
		let k = 0;
		for (const r of rows) {
			if (r.task_id === id && r.ok) k++;
		}
		out.push(k * 2 > repeats);
	}
	return out;
}

/** USD per resolved task (undefined without prices — honest). */
export function costPerResolved(
	tin: number,
	tout: number,
	pin?: number,
	pout?: number,
	resolved = 1,
): number | undefined {
	if (pin === undefined || pout === undefined) return undefined;
	const cost = (tin * pin + tout * pout) / 1e6;
	return cost / Math.max(1, resolved);
}

/** One shape's paired results → report row with verdict. */
export function aggregateShape(
	shape: Shape,
	ids: string[],
	rowsA: TaskResult[],
	rowsB: TaskResult[],
	repeats: number,
	a: Arm,
	b: Arm,
): ShapeReport {
	const pa = majority(rowsA, ids, repeats);
	const pb = majority(rowsB, ids, repeats);
	const pairs = ids.map((_, i) => ({ a: pa[i] ?? false, b: pb[i] ?? false }));
	const lat = (rows: TaskResult[]): number[] =>
		rows.filter((r) => r.error === undefined).map((r) => r.latency_ms);
	const sa = armShape(rowsA, ids, repeats, lat(rowsA));
	const sb = armShape(rowsB, ids, repeats, lat(rowsB));
	const st = shapeStats(shape, sa, sb, pairs);
	const prA = costPerResolved(
		sa.tokens_in,
		sa.tokens_out,
		a.price_in,
		a.price_out,
		sa.ok,
	);
	const prB = costPerResolved(
		sb.tokens_in,
		sb.tokens_out,
		b.price_in,
		b.price_out,
		sb.ok,
	);
	const v = decideShape(st, { a: prA, b: prB });
	const [loA, hiA] = wilson(sa.ok, sa.n);
	const [loB, hiB] = wilson(sb.ok, sb.n);
	const pct = (x: number): number => Math.round(x * 1000) / 10;
	return {
		shape,
		n: sa.n,
		acc_a: pct(sa.ok / Math.max(1, sa.n)),
		lo_a: pct(loA),
		hi_a: pct(hiA),
		acc_b: pct(sb.ok / Math.max(1, sb.n)),
		lo_b: pct(loB),
		hi_b: pct(hiB),
		overlap: st.overlap,
		mcnemar_p: Math.round(st.mcnemar_p * 10000) / 10000,
		diff: pct(st.diff),
		lat_p50_a: sa.latency_p50_ms,
		lat_p50_b: sb.latency_p50_ms,
		per_resolved_a: prA,
		per_resolved_b: prB,
		powered: st.powered,
		verdict: v.verdict,
		decided_by: v.decided_by,
		note: v.note,
	};
}

/** Human table on stderr — per-shape verdicts at a glance. */
export function renderTable(reports: ShapeReport[]): string {
	const rows = reports.map((r) => {
		const band = (acc: number, lo: number, hi: number): string => {
			const a = acc.toFixed(1).padStart(5);
			const ci = `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`;
			return `${a}% ${ci}`;
		};
		const pr = (x?: number): string =>
			x === undefined ? "—" : `$${x.toFixed(6)}`;
		return [
			r.shape.padEnd(10),
			String(r.n).padStart(4),
			band(r.acc_a, r.lo_a, r.hi_a).padEnd(24),
			band(r.acc_b, r.lo_b, r.hi_b).padEnd(24),
			(r.overlap ? "tie" : "sep").padEnd(4),
			r.verdict.padEnd(8),
			r.decided_by.padEnd(8),
			pr(r.per_resolved_a).padEnd(10),
			pr(r.per_resolved_b),
		].join(" | ");
	});
	const head = [
		"shape",
		"n",
		"arm A acc [wilson95]",
		"arm B acc [wilson95]",
		"sep",
		"verdict",
		"by",
		"$/res A",
		"$/res B",
	]
		.map((h) => h.padEnd(10))
		.join(" | ");
	return [head, ...rows].join("\n");
}
