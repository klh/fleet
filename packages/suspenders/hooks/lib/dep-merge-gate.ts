// dep-merge-gate.ts — W60: a dependency's DONE only unblocks when its
// result_sha is actually an ANCESTOR of the integration branch (main) —
// done ≠ merged (the 2026-09-26 gaps incident: W263 marked DONE with a sha
// living only on its lane branch, and the dependent built against that
// ghost).
//
// Fail-open doctrine (lookup failure is never death): no project worktree,
// missing git, or a git error (unknown sha/ref) all read as "cannot know" —
// the dep counts. Only a VERIFIED negative (`git merge-base --is-ancestor`
// exit 1) gates. Spawned with an argument array; exit 1 is expected control
// flow, never an error.
import { existsSync } from "node:fs";
import { projectRootOf } from "./govdb.ts";

export type DepRow = {
	depends_on: string;
	state: string | null;
	result_sha: string | null;
};

// per-run memo: one git probe per sha
const _ancestry = new Map<string, boolean | null>();

export function projectWorktree(project: string): string | null {
	// project is the git COMMON dir (<repo>/.git for a normal checkout) — the
	// integration worktree lives beside it. Bare/odd layouts have none → null
	// → fail-open (same suffix logic as the work-graph mirror path).
	if (!project.endsWith("/.git")) return null;
	return projectRootOf(project);
}

export function shaOnMain(sha: string, project: string): boolean | null {
	const wt = projectWorktree(project);
	if (!wt || !existsSync(wt)) return null; // no worktree to ask — fail-open
	const hit = _ancestry.get(sha);
	if (hit !== undefined) return hit;
	const r = Bun.spawnSync(
		["git", "-C", wt, "merge-base", "--is-ancestor", sha, "main"],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const v = r.exitCode === 0 ? true : r.exitCode === 1 ? false : null; // >1 = git trouble — never a verdict
	_ancestry.set(sha, v);
	return v;
}

// DONE deps whose sha is verified NOT on main — these gate (done ≠ merged)
export function unmergedDeps(
	rows: DepRow[],
	project: string,
): { dep: string; sha: string }[] {
	const out: { dep: string; sha: string }[] = [];
	for (const d of rows) {
		if (d.state !== "DONE" || !d.result_sha) continue; // no sha recorded — nothing to verify, DONE counts
		if (shaOnMain(d.result_sha, project) === false)
			out.push({ dep: d.depends_on, sha: d.result_sha });
	}
	return out;
}

export function unmergedNote(rows: DepRow[], project: string): string | null {
	const u = unmergedDeps(rows, project);
	return u.length
		? u
				.map((x) => `dep ${x.dep} done but unmerged (sha not on main)`)
				.join("; ")
		: null;
}
