import {
	isAncestor,
	registeredOriginalBaseline,
} from "../lanes/original-baseline.ts";
import { resolveItemWorktree } from "./worktree-lookup.ts";
import { type GovernorStore, projectRootOf } from "../govdb/govdb.ts";

/** Contextless manual claims can use only the item registered branch and its original mint receipt. */
export function manualCompletionBaseline(
	store: Pick<GovernorStore, "query">,
	project: string,
	item: string,
	commit: string,
): { sha: string; tree: string; receipt: number } | null {
	const tree = resolveItemWorktree(projectRootOf(project), item);
	if (!tree) return null;
	if (!isAncestor(tree, commit, "HEAD")) {
		// Only the integration checkout current non-lane tip retains the old root-only form.
		if (legacyIntegrationTip(projectRootOf(project), commit)) return null;
		throw new Error(
			"Manual completion commit is outside its registered item branch",
		);
	}
	const original = registeredOriginalBaseline(store, { project, item, tree });
	if (!original || !isAncestor(tree, original.sha, commit))
		throw new Error(
			"Manual completion requires its registered original baseline and agreeing mint receipt",
		);
	return { ...original, tree };
}

function legacyIntegrationTip(root: string, commit: string): boolean {
	const read = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", root, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.exitCode === 0 ? p.stdout.toString().trim() : null;
	};
	const branch = read("symbolic-ref", "--short", "HEAD");
	return Boolean(
		branch &&
			!branch.startsWith("suspenders/") &&
			read("rev-parse", "HEAD") === commit,
	);
}
