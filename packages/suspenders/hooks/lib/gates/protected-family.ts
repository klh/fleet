// hooks/lib/gates/protected-family.ts — W2571: the protected design family
// (W2267/W2269/W2550/W2560 + their rebase carriers) rides full glm-5.3 ONLY —
// root #102182: an auto review for a glm53-only item ran glm-5.3-flash via the
// health re-pin + fallback ladder (flash legs, then a 429/502 trail). In the
// supported review path these items are pinned full-5.3-only: no flash
// fallback leg, no model-health demotion/repin, and the strict model
// assertion FAILS LOUD when the served wire id is not the requested class —
// instead of silently riding a fallback. Scoped to review selection for
// tagged items; NO global model change for unrelated projects.
//
// Detection = the work item's `glm53-only` tag, inherited down the parent
// chain (a rebase carrier or repair child inherits its ancestor's pin).
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { splitTags } from "../work/work-tags.ts";
import type { WireModelMatch } from "./wire-model-check.ts";
import { wireModelMatch } from "./wire-model-check.ts";

/** The tag that marks a protected-family item. */
export const PROTECTED_FAMILY_TAG = "glm53-only";

/** The ONLY model class a protected-family review may ride. `wireModelMatch`
 *  folds routing prefixes (`zai-`) and dots-to-dashes; a flash/stepdown
 *  class never matches the full core (`glm-5-3` ≠ `glm-5-3-flash`). */
export const PROTECTED_REVIEW_CLASS = "glm-5.3";

const LINEAGE_DEPTH = 8;

/** True when the item, or any ancestor, carries the protected-family tag.
 *  Fail-open: unreadable lineage = not protected (the W1243 discipline —
 *  detection guards effort, never correctness of the ladder itself). */
export const protectedFamily = (
	db: GovernorStore,
	project: string,
	item: string,
): boolean => {
	const seen = new Set<string>([item]);
	let cursor: string | null = item;
	for (let depth = 0; cursor && depth < LINEAGE_DEPTH; depth += 1) {
		let row: { tags: string | null; parent_id: string | null } | null;
		try {
			row = db
				.query(
					"SELECT tags, parent_id FROM work_items WHERE project = ? AND id = ?",
				)
				.get(project, cursor) as {
				tags: string | null;
				parent_id: string | null;
			} | null;
		} catch {
			return false;
		}
		if (!row) break;
		if (splitTags(row.tags).includes(PROTECTED_FAMILY_TAG)) return true;
		if (!row.parent_id || seen.has(row.parent_id)) break;
		seen.add(row.parent_id);
		cursor = row.parent_id;
	}
	return false;
};

/** The scheduler's loud refusal when a protected item's pin is not the full
 *  class — the review never launches on a fallback-capable pin. */
export const protectedFamilyRefusal = (model: string | undefined): string =>
	`protected-family review refused: pinned model ${model ?? "(unset)"} is not ${PROTECTED_REVIEW_CLASS} — no flash fallback, no model-health repin (W2571)`;

/** The strict assertion face: a protected-family review may never ride a
 *  fallback — a served wire id outside the requested class is a loud ERROR
 *  regardless of the verdict, so a flash leg can never bank a receipt. */
export const protectedWireMismatch = (o: {
	match: WireModelMatch | null | undefined;
	verdict: string;
	family: boolean;
}): boolean =>
	o.match === "mismatch" && (o.verdict === "PASS" || o.family);
