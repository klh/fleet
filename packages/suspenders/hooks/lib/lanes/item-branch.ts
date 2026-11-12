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

const commitOnBranch = (root: string, sha: string, branch: string): boolean =>
	Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"merge-base",
			"--is-ancestor",
			sha,
			`refs/heads/${branch}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	).exitCode === 0;

// W3010 graph facts: the walk never opens a store itself — the caller (the
// review leg already holds the db and the item row) supplies the parent_id
// entry point, the pinned result sha, and an ancestor row resolver.
export interface ItemBranchGraph {
	parentId: string | null;
	resultSha?: string | null;
	rowAt: (id: string) => { state: string; parent_id: string | null } | null;
}

export function branchForItem(
	root: string,
	item: string,
	graph?: ItemBranchGraph,
): string | null {
	const named = `suspenders/${item}`;
	if (refExists(root, named)) return named;
	for (const e of registryWorktrees(root)) {
		if (!e.branch) continue;
		if (readLaneContextFile(e.path)?.item === item) return e.branch;
	}
	return walkKeptCarrier(root, graph);
}

// W3010: a kept child's carrier can outlive its lane-context (reaped/retired
// tree, pre-W628 split — the 77aa incident). Walk the parent_id chain while
// ancestors stay SHATTERED; bind the first ancestor whose parent-named ref
// exists — and ONLY when that ref contains the item's result_sha (merge-base
// --is-ancestor). Done items null owner_sid, so the W3009 owner anchor is
// unavailable here; result-sha containment IS the binding proof, and a
// ref-bearing ancestor missing the sha binds nothing (wrong carrier never
// binds). No graph facts or no pinned result → no graph binding.
const SHATTERED_CHAIN_CAP = 8; // acyclic graph; ids are finite-depth
const walkKeptCarrier = (
	root: string,
	graph?: ItemBranchGraph,
): string | null => {
	if (!graph?.resultSha) return null;
	let cur = graph.parentId;
	for (let depth = 0; cur && depth < SHATTERED_CHAIN_CAP; depth++) {
		const row = graph.rowAt(cur);
		if (row?.state !== "SHATTERED") return null;
		const branch = `suspenders/${cur}`;
		if (refExists(root, branch))
			return commitOnBranch(root, graph.resultSha, branch) ? branch : null;
		cur = row.parent_id;
	}
	return null;
};
