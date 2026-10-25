// worktree-lookup.ts — resolve an item's worktree from ground truth, not
// derivation (W211). `work done` used to compute the path as
// `PROJECT.slice(0, -4) + ".worktrees/<id>"` and silently skipped the retire
// whenever the tree actually stood elsewhere (registry-parked lanes) or the
// project identity wasn't `<root>/.git`. git's worktree registry is the truth
// — the same doctrine the sweep already states ("porcelain is ground truth").
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeEntry {
	path: string;
	branch: string | null;
}

// one git spawn, registry rows: worktree <path> + optional branch <ref>
export function registryWorktrees(root: string): WorktreeEntry[] {
	const r = Bun.spawnSync(
		["git", "-C", root, "worktree", "list", "--porcelain"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (r.exitCode !== 0) return []; // no registry to ask — fail open
	const entries: WorktreeEntry[] = [];
	let cur: WorktreeEntry | null = null;
	for (const line of r.stdout.toString().split("\n")) {
		if (line.startsWith("worktree ")) {
			cur = { path: line.slice("worktree ".length), branch: null };
			entries.push(cur);
		} else if (line.startsWith("branch ") && cur) {
			cur.branch = line
				.slice("branch ".length)
				.trim()
				.replace(/^refs\/heads\//, "");
		}
	}
	return entries;
}

// the item's worktree: the tree checked out on suspenders/<id>, else the
// conventional .worktrees/<id> when it still stands (registry pruned), else
// null — "no tree" (the majority case stays quiet, as before)
export function resolveItemWorktree(root: string, id: string): string | null {
	const branch = `suspenders/${id}`;
	const hit = registryWorktrees(root).find((e) => e.branch === branch);
	if (hit) return hit.path;
	const conventional = join(root, ".worktrees", id);
	return existsSync(conventional) ? conventional : null;
}
