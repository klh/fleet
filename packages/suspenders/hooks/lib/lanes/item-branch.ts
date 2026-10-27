// item-branch.ts — W1279 canonical child binding: `work split --keep` keeps
// the physical worktree on the PARENT-named branch while the claim moves to
// the child (W628 rebind), so neither `suspenders/<child>` nor the lane
// registry row (still the parent item until relaunch) tells the review/merge
// plane which item owns the branch. The lane-context file — rebound in the
// same transaction as the shatter — is the canonical child context: branch →
// item for the merge ladder's lease gate, item → branch for the reviewer.

import { registryWorktrees } from "../work/worktree-lookup.ts";
import { readLaneContextFile } from "./lane-context.ts";

// the item a branch is bound to: the checked-out tree's lane-context (kept
// child wins over a stale registry row), else null — callers layer their own
// registry-row and branch-name-suffix fallbacks
export function laneContextItemForBranch(
	root: string,
	branch: string,
): string | null {
	const tree = registryWorktrees(root).find((e) => e.branch === branch);
	if (!tree) return null;
	return readLaneContextFile(tree.path)?.item ?? null;
}

// the branch an item's review binds to: its own ref when it exists (the
// normal lane), else the branch of the worktree whose lane-context binds the
// item (split --keep kept child), else null — the caller falls back to
// suspenders/<item> so the familiar loud rev-parse error survives.
const refExists = (root: string, ref: string): boolean =>
	Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${ref}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	).exitCode === 0;

export function branchForItem(root: string, item: string): string | null {
	const named = `suspenders/${item}`;
	if (refExists(root, named)) return named;
	for (const e of registryWorktrees(root)) {
		if (!e.branch) continue;
		if (readLaneContextFile(e.path)?.item === item) return e.branch;
	}
	return null;
}
