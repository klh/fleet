// hooks/lib/work/work-tags.ts — W846: mint-time item classification. `work add
// --tag t1,t2` stamps the work_items.tags column (comma-joined with the
// W517 .prefer tree tag) so counters (pilot-measure rework) classify by
// TAG, never by title regex. The tag grammar is the .prefer token grammar
// (prefer.ts TAG_RE) — one source of truth for both surfaces.
import { TAG_RE } from "./prefer.ts";

/** The owner-gate classification tag (W2338): `operator` marks owner-only
 *  work machines must not hand to lanes — the machine-readable half of
 *  ownerGatedItem, minted automatically by insertItem on a gated title. */
export const OWNER_GATE_TAG = "operator";

/** Comma-split a tags column value into its tag set (trims, drops empties). */
export const splitTags = (raw: string | null | undefined): string[] =>
	(raw ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

/** W2338: the ONE owner-gate predicate — an OWNER-GATED title prefix or the
 *  `operator` classification tag. The take gate, the allocator planner, the
 *  refill pool filter and the report's needs-you facts all render from this
 *  (moved from work-report.ts so the machine gates share the report's
 *  definition instead of re-deriving a second one from title prose). */
export const ownerGatedItem = (title: string, tags: string | null): boolean =>
	title.startsWith("OWNER-GATED") || splitTags(tags).includes(OWNER_GATE_TAG);

/** Validate a --tag flag value; returns the normalized csv; throws on a bad token. */
export function validateTags(raw: string): string {
	const tags = splitTags(raw);
	if (tags.length === 0) throw new Error("needs at least one tag");
	for (const t of tags)
		if (!TAG_RE.test(t))
			throw new Error(
				`invalid tag: ${t} — alphanumeric start, letters/digits/dash, ≤32 chars`,
			);
	return tags.join(",");
}

/** Distinct union of two tag sets (order-preserving); null when both empty. */
export function mergeTags(
	a: string | null | undefined,
	b: string | null | undefined,
): string | null {
	const merged: string[] = [];
	for (const t of [...splitTags(a), ...splitTags(b)])
		if (!merged.includes(t)) merged.push(t);
	return merged.length > 0 ? merged.join(",") : null;
}
