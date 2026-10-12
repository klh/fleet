// lane-context.ts — the lane's activation context file:
// .fleet/lane-context.json in the lane's worktree ({ sid, item, baseline,
// launchedAt }), written by dispatch at spawn. W628: `work split --keep` is a
// claim TRANSFER — the keeping lane's context must follow the claim, so the
// rebind runs inside the same transaction as the shatter (a failed rewrite
// rolls the shatter back). Pre-fix splits left the context bound to the
// SHATTERED parent and the W621.1 lane had to hand-edit its own context to
// close.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveItemWorktree } from "./worktree-lookup.ts";

export interface LaneActivationContext {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
}

export const laneContextFile = (dir: string): string =>
	join(dir, ".fleet", "lane-context.json");

/** Parsed context, or null when absent/corrupt. A corrupt file is
 * completion-time's hard error, never split's to overwrite blind. */
export function readLaneContextFile(dir: string): LaneActivationContext | null {
	const path = laneContextFile(dir);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LaneActivationContext;
	} catch {
		return null;
	}
}

/** Rebind one context file to the kept child. Only a context bound to exactly
 * (sid, fromItem) is rewritten — foreign, already-rebound or corrupt contexts
 * are left untouched. Returns toItem on a rewrite, else null. */
export function rebindLaneContext(
	dir: string,
	sid: string,
	fromItem: string,
	toItem: string,
): string | null {
	const context = readLaneContextFile(dir);
	if (!context || context.sid !== sid || context.item !== fromItem) return null;
	writeFileSync(
		laneContextFile(dir),
		JSON.stringify({ ...context, item: toItem }),
	);
	return toItem;
}

/** Candidate dirs holding the keeping lane's context, most-likely first: the
 * splitter's cwd (the lane splits its own claim from its worktree), then the
 * shattered parent's worktree per git's worktree registry, else the
 * conventional .worktrees/<parent> (W211 ground truth). Deduped. */
export function keptLaneContextDirs(
	cwd: string,
	root: string,
	parentItem: string,
): string[] {
	const out: string[] = [];
	for (const dir of [cwd, resolveItemWorktree(root, parentItem)]) {
		if (dir && !out.includes(dir)) out.push(dir);
	}
	return out;
}

/** W628: rebind the keeping lane's context to the kept child, trying each
 * candidate dir. Called inside split's transaction — a thrown rewrite rolls
 * the shatter back with it. Returns toItem when some candidate's context was
 * rebound, else null (no matching context: manual splits, remote lanes). */
export function rebindKeptLaneContext(
	cwd: string,
	root: string,
	parentItem: string,
	sid: string,
	toItem: string,
): string | null {
	for (const dir of keptLaneContextDirs(cwd, root, parentItem))
		if (rebindLaneContext(dir, sid, parentItem, toItem)) return toItem;
	return null;
}
