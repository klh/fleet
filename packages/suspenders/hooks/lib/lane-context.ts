// hooks/lib/lane-context.ts — the lane identity packet dispatch writes at
// spawn (.fleet/lane-context.json, or the shared .fleet/lanes.json index for
// bare worktrees). One reader for every hook that needs sid+item (W510:
// extracted from lane-completion.ts, its second consumer appeared).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "./run.ts";

export type LaneContext = {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
	worktree?: string;
};

// Git toplevel first, then the git-common-dir sibling index. Returns
// undefined when neither resolves to exactly one lane — ambiguity never
// guesses.
export function laneContext(cwd: string): LaneContext | undefined {
	if (!cwd || !existsSync(cwd)) return undefined;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) return undefined;
	const wt = top.out.trim();
	return readLocal(wt) ?? fromIndex(wt);
}

// .fleet/lane-context.json inside this worktree wins.
function readLocal(wt: string): LaneContext | undefined {
	const local = join(wt, ".fleet/lane-context.json");
	if (!existsSync(local)) return undefined;
	try {
		return JSON.parse(readFileSync(local, "utf8")) as LaneContext;
	} catch {
		return undefined;
	}
}

// Bare worktrees resolve through the shared index at the git-common-dir
// sibling; exactly one worktree match, else undefined.
function fromIndex(wt: string): LaneContext | undefined {
	const common = run("git", ["rev-parse", "--git-common-dir"], { cwd: wt });
	if (!common.ok) return undefined;
	const index = join(
		dirname(resolve(wt, common.out.trim())),
		".fleet/lanes.json",
	);
	if (!existsSync(index)) return undefined;
	try {
		const rows = JSON.parse(readFileSync(index, "utf8")) as LaneContext[];
		const matches = rows.filter(
			(row) => row.worktree && resolve(row.worktree) === wt,
		);
		return matches.length === 1 ? matches[0] : undefined;
	} catch {
		return undefined;
	}
}
