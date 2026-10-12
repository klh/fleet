// hooks/lib/govdb-project.ts — one project identity for the whole
// control plane: the realpath of the repo's COMMON git dir, so every
// worktree of one repo shares one Work Graph key (W624 split).
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

// one project identity for the whole control plane: realpath of the repo's
// COMMON git dir — every worktree of one repo shares one Work Graph, and
// work.ts / coord.ts bootstrap / a future consult layer can never disagree.
// The optional dir (W460) keeps resolving the SAME identity for an explicit
// repo (harvest --repo) instead of re-deriving it differently.
function gitCommonDir(dir: string): string | null {
	try {
		const r = Bun.spawnSync(
			["git", "-C", dir, "rev-parse", "--git-common-dir"],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (r.exitCode === 0) {
			const d = new TextDecoder().decode(r.stdout).trim();
			if (d) return realpathSync(resolve(dir, d));
		}
	} catch {}
	return null;
}

export function projectIdentity(dir: string = process.cwd()): string {
	return gitCommonDir(dir) ?? realpathSync(dir);
}

// W459.1 — resolved-project interface (docs/cross-hub-project-identity.md):
// the LOGICAL key and the LOCAL paths are different things. Stage 1 keeps the
// key's value (common-dir realpath) — later stages swap the VALUE behind this
// contract; consumers stop re-deriving paths from the key string.
export interface ResolvedProject {
	/** logical graph-partition key (today: canonical common-git-dir realpath) */
	id: string;
	/** local: the canonical common git dir backing the key */
	commonDir: string;
	/** local: checkout root owning the common dir — `.fleet`/`.worktrees` live
	 * here; inside a linked worktree this is the PARENT checkout root */
	root: string;
	/** local: where resolution ran (a linked worktree keeps its own cwd) */
	cwd: string;
}

// The one resolver behind the interface: one git spawn, all four facts.
export function resolveProject(dir: string = process.cwd()): ResolvedProject {
	const cwd = realpathSync(dir);
	const commonDir = gitCommonDir(cwd);
	if (!commonDir) return { id: cwd, commonDir: cwd, root: cwd, cwd };
	return { id: commonDir, commonDir, root: dirname(commonDir), cwd };
}

// local path getter for consumers holding a KEY string (board routes, orch):
// today's keys ARE common-dir paths, so the checkout root is the strip.
// Enrollment (stage 3) replaces this body with a registry lookup at the same
// seams — call sites never change again.
export const projectRootOf = (project: string): string =>
	project.endsWith("/.git") ? project.slice(0, -5) : project;
