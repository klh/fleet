// W1730: the registered original product baseline of an item tree — the
// commit git recorded when it CREATED suspenders/<item>, corroborated by the
// fresh-mint work.tree receipt for this exact project, item and tree under a
// prior claim. A retake inheriting the item's own earlier product resumes
// from it; minting the evidence window at the inherited HEAD hides that
// product and refuses an honest completion.
import { realpathSync } from "node:fs";
import type { GovernorStore } from "../govdb/govdb.ts";
import { projectIdentity, projectRootOf } from "../govdb/govdb-project.ts";
import { registryWorktrees } from "../work/worktree-lookup.ts";

export type OriginalBaseline = { sha: string; receipt: number };
export type BaselineRestore = { from: string; to: string; receipt: number };
type TreeReceipt = Record<string, string | undefined>;

// the mint emits its receipt right after `git worktree add -b`; reflog
// timestamps are whole seconds
const MINT_SKEW_MS = { before: 1_000, after: 120_000 };

const git = (tree: string, ...args: string[]): string | null => {
	const p = Bun.spawnSync(["git", "-C", tree, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

export const isAncestor = (
	tree: string,
	older: string,
	newer: string,
): boolean => git(tree, "merge-base", "--is-ancestor", older, newer) !== null;

/** Only the branch's OLDEST reflog entry, and only a creation, pins a base. */
function branchCreation(
	tree: string,
	branch: string,
): { sha: string; at: number } | null {
	const oldest =
		git(
			tree,
			"log",
			"-g",
			"--date=unix",
			"--format=%H|%gd|%gs",
			`refs/heads/${branch}`,
		)
			?.split("\n")
			.at(-1) ?? "";
	const [, sha, at] =
		/^([0-9a-f]{40})\|[^|]*@\{(\d+)\}\|branch: Created from /.exec(oldest) ??
		[];
	return sha && at ? { sha, at: Number(at) * 1000 } : null;
}

/** The verified original baseline, else null. Every leg must agree: git's
 * worktree registry and project identity, the branch creation entry, the
 * newest fresh-mint receipt for this project/item/tree minted after a claim
 * of the same item, and ancestry of the tree's HEAD. An item that already
 * completed never re-offers its credited product. Any doubt keeps HEAD. */
export function registeredOriginalBaseline(
	store: GovernorStore,
	args: { project: string; item: string; tree: string },
): OriginalBaseline | null {
	try {
		const { project, item, tree } = args;
		const branch = `suspenders/${item}`;
		const real = realpathSync(tree);
		if (
			projectIdentity(tree) !== project ||
			!registryWorktrees(projectRootOf(project)).some(
				(entry) => entry.branch === branch && realpathSync(entry.path) === real,
			)
		)
			return null;
		const created = branchCreation(tree, branch);
		if (!created) return null;
		const rows = store
			.query(
				"SELECT id, ts, payload FROM events WHERE kind='work.tree' AND source='worktree' AND project=? AND work=? ORDER BY id DESC",
			)
			.all(project, item) as { id: number; ts: number; payload: string }[];
		const mint = rows.find((row) => {
			const p = JSON.parse(row.payload) as TreeReceipt;
			return !(p.kept || p.retired || p.swept || p.branch_existed);
		});
		if (!mint) return null;
		const receipt = JSON.parse(mint.payload) as TreeReceipt;
		const skew = mint.ts - created.at;
		if (
			receipt.branch !== branch ||
			!receipt.path ||
			realpathSync(receipt.path) !== real ||
			(receipt.base !== undefined && receipt.base !== created.sha) ||
			skew < -MINT_SKEW_MS.before ||
			skew > MINT_SKEW_MS.after ||
			!store
				.query(
					"SELECT 1 FROM events WHERE kind='work.claimed' AND source='work' AND project=? AND work=? AND id < ? LIMIT 1",
				)
				.get(project, item, mint.id) ||
			store
				.query(
					"SELECT 1 FROM events WHERE kind='work.done' AND project=? AND work=? LIMIT 1",
				)
				.get(project, item) ||
			!isAncestor(tree, created.sha, "HEAD")
		)
			return null;
		return { sha: created.sha, receipt: mint.id };
	} catch {
		return null;
	}
}
