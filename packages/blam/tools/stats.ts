// tools/stats.ts — inter-annotator agreement statistics for BLAM.
// Cohen's kappa over crash_class labels; the paper reports kappa >= 0.7 as
// the adoption bar (docs/labeling-protocol.md).
export function kappa(a: string[], b: string[]): number {
	if (a.length !== b.length || a.length === 0) {
		throw new Error("kappa: label arrays must be equal, non-zero length");
	}
	const n = a.length;
	const classes = [...new Set([...a, ...b])];
	const po = a.filter((x, i) => x === b[i]).length / n;
	const pe = classes.reduce((sum, c) => {
		const pa = a.filter((x) => x === c).length / n;
		const pb = b.filter((x) => x === C1(c)).length / n;
		return sum + pa * pb;
	}, 0);
	return (po - pe) / (1 - pe);
}

// C1: identity — kept as a named helper so the kappa body reads as the
// textbook formula.
const C1 = (c: string): string => c;

export function classCounts(labels: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
	return m;
}
