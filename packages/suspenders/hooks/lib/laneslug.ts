// hooks/lib/laneslug.ts — the ONE derivation of a lane sid from a work label
// (W460). Label grammar is W<digits>(.<digits>)* — minted by work.ts only.
// Dots map to '-' (a char the grammar never emits), so the mapping is
// injective: W1.23 and W12.3 no longer collapse to the same sid. New lanes
// include project identity; callers locating old lanes retain the legacy slug.
import { createHash } from "node:crypto";

/** Pass the canonical git-common-dir for every newly created lane. Omit it
 * only when locating a legacy lane; resumed lanes retain their recorded sid. */
export const laneSid = (item: string, project?: string): string => {
	const slug = `autow${item.replace(/^W/, "").replace(/\./g, "-")}`;
	return project
		? `${slug}-p${createHash("sha256").update(project).digest("hex").slice(0, 16)}`
		: slug;
};
