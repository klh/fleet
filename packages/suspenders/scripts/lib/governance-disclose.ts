// scripts/lib/governance-disclose.ts — W1119.2: the W463 override-disclosure
// writers (1500-law decomposition from dispatch-next.ts). Every ungoverned
// ride is loud on stdout AND disclosed IN the brief the lane reads.
import { writeFileSync } from "node:fs";

/** The --no-belt override note: belt/buckle selection skipped — the lane
 *  rides ungoverned, no buckle scopes, attribution or budgets. */
export const noBeltNote = (): string =>
	"UNGOVERNED DISPATCH — operator override (--no-belt): belt/buckle selection skipped; lane rides ungoverned — no buckle scopes, attribution or budgets";

/** Persist the disclosed brief to both surfaces — the canonical .fleet copy
 *  and the readable worktree copy the lane actually reads (W432). */
export const discloseInBrief = (
	brief: string,
	briefFile: string,
	wt: string,
	note: string,
): void => {
	const disclosed = `${brief}\n\nGOVERNANCE: ${note}.\n`;
	writeFileSync(briefFile, disclosed);
	writeFileSync(`${wt}/.klh-brief.md`, disclosed);
};
