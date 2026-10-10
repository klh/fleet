// hooks/lib/laneslug.ts — the ONE derivation of a lane sid from a work label
// (W460). Label grammar is W<digits>(.<digits>)* — minted by work.ts only.
// Dots map to '-' (a char the grammar never emits), so the mapping is
// injective: W1.23 and W12.3 no longer collapse to the same sid. New lanes
// include project identity; callers locating old lanes retain the legacy slug.
import { createHash } from "node:crypto";

/** the shared W-label core: strips the W, maps dots to '-' (a char the
 *  work.ts label grammar never emits) — injective for W<digits>(.<digits>)*.
 *  W614: supervisor sids share this so sup-W1.23 and sup-W12.3 can't collide. */
const labelSlug = (item: string): string =>
	item.replace(/^W/, "").replace(/\./g, "-");

/** Pass the canonical git-common-dir for every newly created lane. Omit it
 * only when locating a legacy lane; resumed lanes retain their recorded sid. */
export const laneSid = (item: string, project?: string): string => {
	const slug = `autow${labelSlug(item)}`;
	return project
		? `${slug}-p${createHash("sha256").update(project).digest("hex").slice(0, 16)}`
		: slug;
};

/** micro-supervisor sid (W614): same injective label grammar, `sup` prefix. */
export const supSid = (item: string): string => `sup${labelSlug(item)}`;
