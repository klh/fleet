// hooks/lib/lanes/lane-context-mint.ts — W2786 decomposition: the lane
// activation-context mint (the completionContext / freshBaseline block),
// moved verbatim out of fleet-loop/lane-launch.ts (1200-line stop rule,
// W1238.6 — the breaker integration bought its lines with this extraction).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GovernorStore } from "../govdb/govdb.ts";
import { restorableBaseline } from "./original-baseline.ts";

export function mintCompletionContext(
	store: GovernorStore,
	lane: { sid: string; item: string; wt: string; project: string },
	takeToken: string | null,
	sh: (cmd: string[], cwd?: string) => string,
): void {
	// Immutable evidence base survives resumes and later main-branch merges.
	const completionContext = `${lane.wt}/.fleet/lane-context.json`;
	mkdirSync(`${lane.wt}/.fleet`, { recursive: true });
	// W1730: a fresh context over the item's own earlier product (a released
	// manual take, a re-minted tree) starts at its registered original base
	// — HEAD when none verifies or its span holds no own commits
	const freshBaseline = (): string => {
		const head = sh(["git", "-C", lane.wt, "rev-parse", "HEAD"]);
		return (
			restorableBaseline(
				store,
				{ project: lane.project, item: lane.item, tree: lane.wt },
				head,
			)?.sha ?? head
		);
	};
	if (takeToken) {
		// W643: merge the fresh take token into the activation context —
		// create-with-baseline when absent, token-only merge when it exists
		// (a re-take after a reclaim refreshes the token, never the baseline).
		const prior = existsSync(completionContext)
			? (JSON.parse(readFileSync(completionContext, "utf8")) as Record<
					string,
					unknown
				>)
			: null;
		writeFileSync(
			completionContext,
			JSON.stringify(
				prior
					? { ...prior, claimToken: takeToken }
					: {
							sid: lane.sid,
							item: lane.item,
							baseline: freshBaseline(),
							launchedAt: Date.now(),
							claimToken: takeToken,
						},
			),
		);
	} else if (!existsSync(completionContext))
		writeFileSync(
			completionContext,
			JSON.stringify({
				sid: lane.sid,
				item: lane.item,
				baseline: freshBaseline(),
				launchedAt: Date.now(),
			}),
		);
}
