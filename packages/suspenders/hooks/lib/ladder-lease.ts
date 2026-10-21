// ladder-lease.ts — W641: the govdb lease as the ladder's merge gate (the
// flush's selection predicate). The lane registry maps branch → item (suffix
// fallback); the graph holds the lease. blocked = item CLAIMED/RUNNING, or
// the store unreadable (lease unverifiable — the must is never merge leased
// work). result_sha is the closure sha from `work done --sha`; flush
// verification resolves it (`rev-parse <sha>^{commit}`) and compares to the
// branch head. W1072.2: doneShaResolves is THE exact merge predicate shared
// by mergeOne (cycle/ship) and flush — only a DONE closure whose result_sha
// resolves to the exact branch head may merge; everything else fails closed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLaneRegistry } from "./lane-registry.ts";
import { openStore, projectIdentity } from "./govdb.ts";

export type ClaimView = {
	item: string;
	blocked: boolean;
	reason: string;
	state: string | null;
	resultSha: string | null;
};

// W1072.2: THE exact merge predicate — item DONE and its result_sha present
// and resolving to the exact branch HEAD. Unknown/stale/reclaimed states and
// empty result_shas all fail closed. Shared by mergeOne (cycle/ship) and
// flush; a resolver failure (bad rev) reads as not-resolved, never as pass.
export function doneShaResolves(
	repo: string,
	branch: string,
	claim: ClaimView,
): { ok: boolean; why: string } {
	if (claim.blocked) return { ok: false, why: claim.reason || "lease blocked" };
	if (claim.state !== "DONE")
		return {
			ok: false,
			why: `item ${claim.item} is ${claim.state ?? "unknown to the graph"}`,
		};
	return shaResolves(repo, branch, claim.resultSha);
}

// the sha half of the predicate: nonempty and resolving to the branch's own
// HEAD via `rev-parse --verify <sha>^{commit}` — a bad rev reads as fail.
export function shaResolves(
	repo: string,
	branch: string,
	sha: string | null,
): { ok: boolean; why: string } {
	const s = sha?.trim();
	if (!s) return { ok: false, why: `item closed without a result_sha` };
	const rev = (ref: string): string =>
		Bun.spawnSync(["git", "rev-parse", "--verify", ref], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		})
			.stdout.toString()
			.trim();
	const full = rev(`${s}^{commit}`);
	const bhead = rev(branch);
	if (!full || !bhead || full !== bhead)
		return {
			ok: false,
			why: `result_sha ${s} does not resolve to branch HEAD`,
		};
	return { ok: true, why: "" };
}

// W1072.2: the operator merge hold — an explicit `.fleet/merge-hold` marker
// distinct from the dispatch pause. Manual integration (cherry-picks, review
// merges) owns the checkout while it exists; the ladder defers ALL merges
// for its lifetime. A deferral, not a failure: no strike, no NEED_DECISION.
export function mergeHoldActive(repo: string): boolean {
	return existsSync(join(repo, ".fleet", "merge-hold"));
}

// W1072.2: Git in-progress state in the integration checkout — a cherry-pick,
// merge, or rebase the operator (or a crashed runner) left unconcluded. The
// ladder must not enter the ladder over any of them; the heal path owns
// MERGE_HEAD debris, but cherry-pick/rebase state is operator work: defer.
// Resolved via `git rev-parse --git-path` — correct in linked worktrees where
// the state files live under .git/worktrees/<n>/, not <repo>/.git/.
const MID_OPS = [
	["CHERRY_PICK_HEAD", "cherry-pick in progress"],
	["REBASE_HEAD", "rebase in progress"],
	["rebase-merge", "rebase in progress"],
	["rebase-apply", "rebase/am in progress"],
] as const;

function gitPathExists(repo: string, name: string): boolean {
	const p = Bun.spawnSync(["git", "rev-parse", "--git-path", name], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	})
		.stdout.toString()
		.trim();
	if (!p) return false;
	return existsSync(p.startsWith("/") ? p : join(repo, p));
}

/** Non-merge mid-ops (cherry-pick, rebase) — operator work the crashed-merge
 * heal must never touch; the heal gates read THIS, not gitInProgress. */
export function gitMidOp(repo: string): string | null {
	for (const [file, why] of MID_OPS) {
		if (gitPathExists(repo, file)) return why;
	}
	return null;
}

/** Mid-op OR merge in progress — the full pre-ladder defer gate. */
export function gitInProgress(repo: string): string | null {
	const mid = gitMidOp(repo);
	if (mid) return mid;
	return gitPathExists(repo, "MERGE_HEAD") ? "merge in progress" : null;
}

// one branch → its item's lease state, tri-state by store health
export function itemClaimOf(repo: string, b: string): ClaimView {
	const registry = readLaneRegistry<{ branch: string; item: string }>(repo);
	const entry = registry.known
		? registry.lanes.find((row) => row.branch === b)
		: undefined;
	const item = entry?.item ?? b.split("/").at(-1);
	try {
		const store = openStore();
		try {
			const row = store
				.query(
					"SELECT state, result_sha FROM work_items WHERE project = ? AND id = ?",
				)
				.get(projectIdentity(repo), item) as
				| { state: string; result_sha: string | null }
				| undefined;
			if (!row)
				return {
					item,
					blocked: false,
					reason: `item ${item} unknown to the graph`,
					state: null,
					resultSha: null,
				};
			const leased = ["CLAIMED", "RUNNING"].includes(row.state);
			return {
				item,
				blocked: leased,
				reason: leased
					? `item ${item} is ${row.state}; the claim owns the branch`
					: "",
				state: row.state,
				resultSha: row.result_sha,
			};
		} finally {
			store.close();
		}
	} catch {
		return {
			item,
			blocked: true,
			reason: "govdb lease unverifiable: store unreadable",
			state: null,
			resultSha: null,
		};
	}
}
