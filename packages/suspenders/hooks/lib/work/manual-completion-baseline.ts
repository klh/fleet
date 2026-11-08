import type { GovernorStore } from "../govdb/govdb.ts";
import { projectRootOf } from "../govdb/govdb.ts";
import {
	isAncestor,
	registeredOriginalBaseline,
} from "../lanes/original-baseline.ts";
import { resolveItemWorktree } from "./worktree-lookup.ts";
/** Contextless manual claims can use only the item registered branch and its original mint receipt. */
export function manualCompletionBaseline(
	store: Pick<GovernorStore, "query">,
	project: string,
	item: string,
	commit: string,
): { sha: string; tree: string; receipt: number } | null {
	const tree = resolveItemWorktree(projectRootOf(project), item);
	// Preserve legacy root-only single-commit completion when no item tree contains the candidate.
	if (!tree || !isAncestor(tree, commit, "HEAD")) return null;
	const original = registeredOriginalBaseline(store, { project, item, tree });
	if (!original || !isAncestor(tree, original.sha, commit))
		throw new Error(
			"Manual completion requires its registered original baseline and agreeing mint receipt",
		);
	return { ...original, tree };
}
