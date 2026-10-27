// Explicit local operator repair of graph drift; immutable completion stays intact.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { GovernorStore } from "../govdb/govdb.ts";
import { projectIdentity, projectRootOf } from "../govdb/govdb-project.ts";
import {
	laneProcessIdentity,
	worktreeProcessIdentity,
} from "../lanes/lane-liveness.ts";
import { bytesHash } from "../lanes/reclaim-context-evidence.ts";
import { claimantLanes, matchingClaimantLane } from "../lanes/reclaim-all.ts";
import { completionRecord } from "./work-completion-record.ts";
import { registryWorktrees, resolveItemWorktree } from "./worktree-lookup.ts";

type Evidence = {
	project: string;
	item: string;
	owner: string;
	revision: number;
	completionHash: string;
	productSha: string;
	tree: string;
	head: string;
	attestation: "restore-verified-immutable-completion-without-new-work";
};

export function reconcileCompletion(
	store: GovernorStore,
	project: string,
	item: string,
	args: string[],
): { item: string; state: "DONE"; sha: string; restored: true } {
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);
		return i < 0 ? undefined : args[i + 1];
	};
	if (!args.includes("--force"))
		throw new Error(
			"Explicit local operator --force required; SID is not authentication",
		);
	const path = flag("--evidence");
	if (!path) throw new Error("Private operator evidence required");
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size > 65536
	)
		throw new Error("Evidence must be a regular 0600 file of at most 64 KiB");
	const bytes = readFileSync(path, "utf8");
	const proof = JSON.parse(bytes) as Evidence;
	const owner = flag("--expect-owner");
	const revision = Number(flag("--expect-updated-at"));
	if (
		!owner ||
		!Number.isSafeInteger(revision) ||
		proof.project !== project ||
		proof.item !== item ||
		proof.owner !== owner ||
		proof.revision !== revision ||
		!/^[a-f0-9]{40}$/.test(proof.productSha) ||
		!/^[a-f0-9]{40}$/.test(proof.head) ||
		!/^[a-f0-9]{64}$/.test(proof.completionHash) ||
		proof.attestation !==
			"restore-verified-immutable-completion-without-new-work"
	)
		throw new Error(
			"Evidence must bind the exact project, item, owner and revision",
		);
	const root = projectRootOf(project);
	const tree = resolveItemWorktree(root, item);
	if (!tree || realpathSync(tree) !== realpathSync(proof.tree))
		throw new Error("Evidence tree differs from the registered item tree");
	const git = (...argv: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", tree, ...argv], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0)
			throw new Error("Cannot verify published tree and completion ancestry");
		return p.stdout.toString().trim();
	};
	const inspect = () => {
		if (
			projectIdentity(tree) !== project ||
			!registryWorktrees(root).some(
				(entry) =>
					entry.branch === `suspenders/${item}` &&
					realpathSync(entry.path) === realpathSync(tree),
			)
		)
			throw new Error(
				"Item tree is not registered to this exact project and branch",
			);
		const lane = matchingClaimantLane(claimantLanes(root), owner, item);
		if (
			(lane && laneProcessIdentity(lane) !== false) ||
			worktreeProcessIdentity(tree) !== false
		)
			throw new Error(
				"An actual native process is attached or its absence is unverified",
			);
		if (git("rev-parse", "HEAD") !== proof.head)
			throw new Error("Tree HEAD changed from operator evidence");
		git("merge-base", "--is-ancestor", proof.productSha, "HEAD");
		git("merge-base", "--is-ancestor", proof.head, "origin/main");
		const dirty = git("status", "--porcelain", "--untracked-files=all")
			.split("\n")
			.filter(Boolean)
			.filter(
				(line) => !/^\?\? (node_modules(\/|$)|\.klh-brief\.md$)/.test(line),
			);
		if (dirty.length)
			throw new Error("Tree has unbanked tracked or untracked product work");
	};
	inspect();
	return store.transaction(() => {
		const row = store
			.query(
				"SELECT state,owner_sid,updated_at,result_sha,scope FROM work_items WHERE project=? AND id=?",
			)
			.get(project, item) as {
			state: string;
			owner_sid: string;
			updated_at: number;
			result_sha: string | null;
			scope: string | null;
		} | null;
		if (
			!row ||
			!["CLAIMED", "RUNNING"].includes(row.state) ||
			row.owner_sid !== owner ||
			row.updated_at !== revision
		)
			throw new Error("Claim changed; reconciliation refused");
		const record = completionRecord(store, project, item);
		if (
			!record ||
			bytesHash(JSON.stringify(record)) !== proof.completionHash ||
			record.commit_sha !== proof.productSha ||
			(row.result_sha !== null && row.result_sha !== record.commit_sha)
		)
			throw new Error(
				"Immutable completion differs from exact operator evidence",
			);
		inspect();
		const now = Date.now();
		const updated = store
			.query(
				"UPDATE work_items SET state='DONE',owner_sid=NULL,result_sha=?,updated_at=? WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state=?",
			)
			.run(record.commit_sha, now, project, item, owner, revision, row.state);
		if (!updated.changes)
			throw new Error("Claim CAS changed; reconciliation refused");
		if (row.scope)
			store
				.query(
					"DELETE FROM claims WHERE sid=? AND scope=? AND intent='work-graph' AND NOT EXISTS (SELECT 1 FROM work_items WHERE owner_sid=? AND scope=? AND state IN ('CLAIMED','RUNNING','ORPHANED'))",
				)
				.run(owner, row.scope, owner, row.scope);
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'work','work.completion-reconciled',?,?,?)",
			)
			.run(
				now,
				row.scope,
				JSON.stringify({
					project,
					work: item,
					actor: "operator-reconcile",
					previousOwner: owner,
					previousRevision: revision,
					completionHash: proof.completionHash,
					evidenceHash: bytesHash(bytes),
					sha: record.commit_sha,
					head: proof.head,
				}),
				owner,
			);
		return {
			item,
			state: "DONE" as const,
			sha: record.commit_sha,
			restored: true as const,
		};
	})();
}
