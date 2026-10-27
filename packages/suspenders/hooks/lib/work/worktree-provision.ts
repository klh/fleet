// hooks/lib/work/worktree-provision.ts — W870: provisioning is ONE behavior.
// dispatch/supervise minted .worktrees/<id> pre-spawn; the mint moves into
// `work take` (the single claim gateway) so manual takes, capsule-resumed
// lanes and subagents can never be treeless — and the tree becomes the
// claim's location-of-record for the location-vs-claim write gate
// (lib/claim-location.ts).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { symlinkBuildDirs } from "../builddirs.ts";
import { openStore } from "../govdb/govdb.ts";
import { wireLanePushScope } from "../lane-guard.ts";
import { resolveItemWorktree } from "./worktree-lookup.ts";

export interface MintResult {
	path: string;
	ok: boolean;
	err?: string;
}

export interface ProvisionResult extends MintResult {
	attached: boolean;
}

// mint the item tree: .worktrees/<id> on suspenders/<id> (W349: a surviving
// branch re-checks out at its tip — the fresh checkout IS the reset). Pure
// mechanics; existence guards live with the callers (the worktree create verb
// dies loud on a standing tree; take attaches instead).
export function mintItemWorktree(
	root: string,
	id: string,
	project?: string,
): MintResult {
	const target = join(root, ".worktrees", id);
	const branch = `suspenders/${id}`;
	// keep the isolation dir itself out of every checkout (the create verb's
	// guard, verbatim — one behavior, one source)
	const giPath = join(root, ".gitignore");
	if (
		!existsSync(giPath) ||
		!readFileSync(giPath, "utf8")
			.split("\n")
			.some((l) => l.trim() === ".worktrees/")
	) {
		appendFileSync(giPath, "\n.worktrees/\n");
	}
	const git = (args: string[]): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString().trim(),
			err: p.stderr.toString().trim(),
			code: p.exitCode,
		};
	};
	const branchExists =
		git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code ===
		0;
	const r = branchExists
		? git(["worktree", "add", target, branch])
		: git(["worktree", "add", "-b", branch, target]);
	if (r.code !== 0)
		return {
			path: target,
			ok: false,
			err: r.err || r.out || "git worktree add failed",
		};
	symlinkBuildDirs(root, target);
	// W1730: a fresh mint receipts the commit its branch was created at — the
	// item's registered original baseline (lanes/original-baseline.ts)
	if (project)
		emitWorktreeEvent(
			id,
			project,
			branchExists
				? { path: target, branch, branch_existed: "1" }
				: {
						path: target,
						branch,
						base: git(["rev-parse", `refs/heads/${branch}`]).out,
					},
		);
	return { path: target, ok: true };
}

// the claim-side provision: attach the standing tree, else mint. `work take`
// prints this path; the location-vs-claim gate keys off the same resolution.
// W1141: with the lane guard in enforce mode, a provisioned tree also gets
// its scoped push credential (wireLanePushScope — per-worktree pushurl).
export function provisionForTake(
	root: string,
	id: string,
	project: string,
	sid?: string,
): ProvisionResult {
	const standing = resolveItemWorktree(root, id);
	if (standing) {
		if (sid) wireLanePushScope(root, standing, id, sid);
		return { path: standing, ok: true, attached: true };
	}
	const minted = mintItemWorktree(root, id, project);
	if (minted.ok && sid) wireLanePushScope(root, minted.path, id, sid);
	return { ...minted, attached: false };
}

// the create verb's event shape, verbatim — the bus sees one kind for both
// the verb and the take-side mint
function emitWorktreeEvent(
	wid: string,
	project: string,
	extra: Record<string, string>,
): void {
	try {
		openStore()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'worktree', ?, ?, ?, NULL)",
			)
			.run(
				Date.now(),
				"work.tree",
				wid,
				JSON.stringify({ work: wid, project, ...extra }),
			);
	} catch {
		// bus unavailable (offline mirror fallback) — provisioning still works
	}
}
