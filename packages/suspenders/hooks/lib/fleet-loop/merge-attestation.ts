// fleet-loop/merge-attestation.ts — W2940: the merge-time qlty autofix
// (W869/W2681) runs INSIDE the guarded merge, after the branch review — a
// PASS receipt bound to the branch head must never authorize publishing
// bytes the autofix changed (the W2940 witness: a PASS receipt for
// f045f479 published ad5ec868, which edited three reviewed BLAM files).
// The published candidate is the reviewed bytes exactly when its TREE
// equals the merge-tree preview of integration HEAD × the branch — the
// same preview the receipt's instruction digests were read from. Pure
// Git-object predicates, no store access; exported for the witness tests.
//
// RESTRICTION (phase one, by design): the predicate admits exactly the
// default `git merge --no-ff` result. ANY ladder step that transforms
// content — the W869 qlty autofix, a custom `LADDER` running codegen or a
// formatter — moves the tree and is deferred, not published. That is the
// fail-closed half of the trade: content no reviewer saw never lands, at
// the cost of one branch-side repair round (apply the transform ON the
// branch, re-complete, one fresh review of the normalized bytes). The
// single-pass alternative — normalize BEFORE the first review and bind the
// receipt to that candidate's digest — belongs to a separate item the
// coordinator tracks; it is outside this predicate's scope.
const gitq = (repo: string, args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	return p.stdout.toString();
};

export function postQltyAttestation(o: {
	repo: string;
	branch: string;
	candidateTree?: string;
}): { ok: boolean; why: string } {
	if (!o.candidateTree)
		return {
			ok: false,
			why: "candidate tree unresolvable — post-qlty bytes cannot be attested",
		};
	const preview = gitq(o.repo, ["merge-tree", "--write-tree", "HEAD", o.branch])
		.split("\n")[0]
		.trim();
	if (!/^[0-9a-f]{40,64}$/.test(preview))
		return { ok: false, why: "merge-tree preview failed" };
	if (preview === o.candidateTree) return { ok: true, why: "" };
	return {
		ok: false,
		why: `post-qlty candidate bytes unreviewed (candidate tree ${o.candidateTree.slice(0, 12)} ≠ reviewed preview ${preview.slice(0, 12)}) — the merge-time qlty autofix changed reviewed bytes`,
	};
}

/** Marker the mergeOne defer path keys the deterministic repair on. */
export const QLTY_ATTESTATION_MARK = "reviewed bytes";
