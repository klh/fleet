// runtime-sync.ts — W821 decision core for the post-merge runtime sync:
// after merges land, the installed prefix is synced (syncHarness) and the
// serve surfaces whose packages changed are kickstarted — else the fleet
// serves stale code all day (2026-10-19: W812/W813/W819 landed+merged but no
// tick ever ran syncHarness, and no service was kicked). Pure so the
// fleet-loop sweep and the post-merge-sync.ts entry share ONE decision.

/** Serve-surface rules, data not branches (recovery-map doctrine): a changed
 * path under a package prefix → the launchd labels serving that package's
 * code. Root/docs changes serve nothing and label nothing. */
export const RUNTIME_SYNC_LABEL_RULES: ReadonlyArray<{
	prefix: string;
	labels: readonly string[];
}> = [
	{
		prefix: "packages/belt/",
		labels: ["com.suspenders.belt-swarm", "com.belt.dashboard"],
	},
	{ prefix: "packages/buckle/", labels: ["com.suspenders.buckle-spoke"] },
	{ prefix: "packages/suspenders/", labels: ["com.suspenders.board"] },
];

/** Union of labels serving the changed paths, in rule order, deduped. */
export function labelsForChanges(paths: string[]): string[] {
	const labels: string[] = [];
	for (const rule of RUNTIME_SYNC_LABEL_RULES) {
		if (paths.some((p) => p.startsWith(rule.prefix)))
			labels.push(...rule.labels);
	}
	return labels;
}

export type RuntimeSyncDecision =
	| { action: "sync"; labels: string[] }
	| { action: "skip"; reason: string };

/** One honest verdict, in evaluation order: git → stamp → drift paths. Any
 * "skip" is a waiting/no-op state. A diff that cannot be read still syncs
 * (publish beats staleness) but labels nothing — a kick needs proven need. */
export function decideRuntimeSync(input: {
	/** `git rev-parse <main>` in the fleet root; null = git failed */
	head: string | null;
	/** last-synced main sha from the stamp; null = never synced */
	stamp: string | null;
	/** `git diff --name-only <stamp>..<head>`; null = diff unreadable */
	paths: string[] | null;
}): RuntimeSyncDecision {
	if (input.head === null) return { action: "skip", reason: "git-failed" };
	if (input.stamp === input.head)
		return { action: "skip", reason: "up-to-date" };
	if (input.stamp === null || input.paths === null)
		return { action: "sync", labels: [] };
	return { action: "sync", labels: labelsForChanges(input.paths) };
}
