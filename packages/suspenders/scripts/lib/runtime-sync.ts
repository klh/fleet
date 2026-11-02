// runtime-sync.ts — W821 decision core for the post-merge runtime sync:
// after merges land, the installed prefix is synced (syncHarness) and the
// serve surfaces whose packages changed are kickstarted — else the fleet
// serves stale code all day (2026-10-19: W812/W813/W819 landed+merged but no
// tick ever ran syncHarness, and no service was kicked). W2546: publication
// and activation are separate successes — the decision also re-enters sync
// when the stamp sits at head with an UNSETTLED activation ledger (the W821
// stamp lied "up-to-date" while services ran old code, #101007). Pure so
// the fleet-loop sweep and the post-merge-sync.ts entry share ONE decision.
import {
	skipHoldoffActive,
	syncSettled,
	type PostMergeStamp,
} from "./activation-readiness.ts";

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

/** Every serving label the rules know (the unknown requested set of a v1
 * stamp — one migration run re-verifies them all, then the ledger exists). */
export const allServingLabels = (): string[] => [
	...new Set(RUNTIME_SYNC_LABEL_RULES.flatMap((r) => [...r.labels])),
];

export type RuntimeSyncDecision =
	| { action: "sync"; labels: string[] }
	| { action: "skip"; reason: string };

/** One honest verdict, in evaluation order: git → stamp → holdoff → drift
 * paths → pending activation. Any "skip" is a waiting/no-op state. A diff
 * that cannot be read still syncs (publish beats staleness) but labels
 * nothing — a kick needs proven need. */
export function decideRuntimeSync(input: {
	/** `git rev-parse <main>` in the fleet root; null = git failed */
	head: string | null;
	/** the last-synced stamp (full shape); null = never synced */
	stamp: PostMergeStamp | null;
	/** `git diff --name-only <stamp.main>..<head>`; null = diff unreadable */
	paths: string[] | null;
	/** clock for the --skip-kick holdoff window (default real time). */
	now?: number;
}): RuntimeSyncDecision {
	if (input.head === null) return { action: "skip", reason: "git-failed" };
	const stamp = input.stamp;
	if (stamp !== null && stamp.main === input.head) {
		if (syncSettled(stamp, input.head))
			return { action: "skip", reason: "up-to-date" };
		if (skipHoldoffActive(stamp, input.now ?? Date.now()))
			return { action: "skip", reason: "skip-kick holdoff" };
		return {
			action: "sync",
			labels: stamp.activation?.requested ?? allServingLabels(),
		};
	}
	if (stamp === null || input.paths === null)
		return { action: "sync", labels: [] };
	// New head (#101358): the drift labels activate anew AND every prior
	// UNRESOLVED request rides along — a Buckle carry that failed last main
	// must not vanish because this commit only touched board/docs. Verified
	// prior labels are NOT carried (same-head retention only, #101118).
	const prior = stamp.activation;
	const unresolved =
		prior === undefined
			? []
			: prior.requested.filter((l) => !prior.verified.includes(l));
	return {
		action: "sync",
		labels: [...new Set([...labelsForChanges(input.paths), ...unresolved])],
	};
}
