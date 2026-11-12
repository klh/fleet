/**
 * Journal sequence integrity: a dense per-ledger sequence must contain no
 * gaps. `findGaps` takes the observed sequence numbers (unordered, and
 * duplicate observations are possible when a write is retried) and returns
 * every missing sequence number in ascending order. The expected range is
 * 1..max(expectedMax, highest observed) — a tail shorter than expectedMax
 * is a gap too.
 */

export function findGaps(observed: number[], expectedMax: number): number[] {
	const seen = new Set(observed);
	const gaps: number[] = [];
	const high = expectedMax;
	for (let s = 0; s <= high; s++) {
		if (!seen.has(s)) gaps.push(s);
	}
	return gaps;
}

export interface SequenceReport {
	gaps: number[];
	duplicates: number[];
}

export function auditSequence(
	observed: number[],
	expectedMax: number,
): SequenceReport {
	const counts = new Map<number, number>();
	for (const s of observed) counts.set(s, (counts.get(s) ?? 0) + 1);
	const duplicates = [...counts.entries()]
		.filter(([, n]) => n > 1)
		.map(([s]) => s)
		.sort((a, b) => b - a);
	return { gaps: findGaps(observed, expectedMax), duplicates };
}
