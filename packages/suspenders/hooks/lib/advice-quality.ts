/** The text copied into a decision must be an explicit ruling, not a heading. */
export function usableRecommendation(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const rec = value.trim();
	return (
		rec.length >= 8 &&
		!/^\s*(?:#{1,6}\s*|\*\*|analysis\s+of\b|recommendation\s*:)/i.test(rec) &&
		!/^\(?empty\)?$/i.test(rec)
	);
}

/** Advisors must identify the sentence that the owner can actually send. */
export function recommendationOf(text: string): string | null {
	const rec = text.match(/^RECOMMENDATION:\s*(.+)$/im)?.[1]?.trim();
	return usableRecommendation(rec) ? rec : null;
}
