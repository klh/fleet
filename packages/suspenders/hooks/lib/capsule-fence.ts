// capsule-fence.ts — W643 capsule bounds + the reconciliation check (the
// mission's "make it checked, not prose"): capsules are byte-capped at set,
// record the checkpoint's commit time (freshness/age ride the payload), and
// resume briefs carry a COMPUTED reconciliation verdict from real git
// evidence instead of a "reconcile with the worktree" admonition.
// W687: the item capsule facts key is PROJECT-SCOPED — item ids are
// per-project sequences, so the old global work.<id>.capsule made two
// projects' same-numbered items share one capsule.
import { createHash } from "node:crypto";
import { run } from "./run.ts";

// W687: the item capsule key's project tag — a short sha256 of the graph
// identity (projectIdentity(): the string work_items.project carries), so
// every accessor resolving the identity from its own cwd lands on one key.
export const capsuleProjectTag = (project: string): string =>
	createHash("sha256").update(project).digest("hex").slice(0, 16);

// The one key builder for item capsules — writers (coord capsule set) and
// readers (work show, capsuleEvidence, rekey) share it; never inline the
// literal anywhere.
export const itemCapsuleKey = (project: string, item: string): string =>
	`work.capsule.${capsuleProjectTag(project)}.${item}`;

export const CAPSULE_MAX_BYTES = 2048;

export function assertCapsuleBounds(
	extra: Record<string, string>,
	ts: number,
): string {
	const json = JSON.stringify({ ...extra, ts });
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > CAPSULE_MAX_BYTES)
		throw new Error(
			`capsule exceeds the 2048-byte cap (${bytes} bytes) — bank a shorter hand-off, not prose`,
		);
	return json;
}

export type CapsuleVerdict =
	| "fresh"
	| "behind"
	| "diverged"
	| "none"
	| "unknown";

export interface CapsuleValidity {
	verdict: CapsuleVerdict;
	past: number | null;
	head: string | null;
	checkpoint: string | null;
	bankedAgeMin: number | null;
	checkpointAgeMin: number | null;
	dirty: number;
	lines: string[];
}

/** Compare checkpoint vs head: divergence/ancestry verdict from real git. */
function checkpointVsHead(
	ckpt: string,
	headSha: string,
	repoDir: string | undefined,
): { verdict: CapsuleVerdict; past: number | null } {
	const repo = repoDir ?? ".";
	if (!run("git", ["-C", repo, "cat-file", "-e", `${ckpt}^{commit}`]).ok)
		return { verdict: "diverged", past: null };
	const anc = run("git", [
		"-C",
		repo,
		"merge-base",
		"--is-ancestor",
		ckpt,
		headSha,
	]);
	if (!anc.ok) return { verdict: "diverged", past: null };
	const r = run("git", [
		"-C",
		repo,
		"rev-list",
		"--count",
		`${ckpt}..${headSha}`,
	]);
	const past = Number(r.out.trim()) || 0;
	return { verdict: past === 0 ? "fresh" : "behind", past };
}

/** W643: the computed reconciliation check. Real git evidence, not prose —
 * verdict rides the resume brief and dispatch output. */
export function capsuleValidity(
	capsule: Record<string, unknown> | null,
	opts: {
		repoDir?: string;
		headSha?: string | null;
		dirty?: number | null;
		now?: number;
	},
): CapsuleValidity {
	const now = opts.now ?? Date.now();
	const ckpt =
		typeof capsule?.checkpoint === "string" ? capsule.checkpoint : null;
	const banked = Number(capsule?.ts ?? 0) || null;
	const ckptTs = Number(capsule?.checkpoint_ts ?? 0) || null;
	const bankedAgeMin = banked ? Math.round((now - banked) / 60_000) : null;
	const ckptAgeMin = ckptTs ? Math.round((now - ckptTs * 1000) / 60_000) : null;
	const headSha = opts.headSha ?? null;
	const lines: string[] = [];
	let verdict: CapsuleVerdict = "none";
	let past: number | null = null;
	if (!capsule) {
		lines.push(
			"RESUME CHECK: no capsule banked — starting blind (no hand-off evidence).",
		);
	} else if (!ckpt || ckpt === "none") {
		lines.push(
			'RESUME CHECK: capsule has no checkpoint ("none") — verify the worktree state yourself.',
		);
	} else if (headSha === null && opts.repoDir === undefined) {
		verdict = "unknown";
		lines.push(
			"RESUME CHECK: no git repo available — reachability unproven; reconcile manually.",
		);
	} else if (headSha === null) {
		verdict = "unknown";
		lines.push(
			`RESUME CHECK: head unreadable in ${opts.repoDir} — reconcile manually.`,
		);
	} else {
		const vh = checkpointVsHead(ckpt, headSha, opts.repoDir);
		verdict = vh.verdict;
		past = vh.past;
	}
	if (verdict === "diverged")
		lines.push(
			`RESUME CHECK: checkpoint ${ckpt} does not exist in the repo or is NOT an ancestor of head ${headSha} — capsule evidence diverged; reconcile manually.`,
		);
	else if (verdict === "fresh")
		lines.push(
			`RESUME CHECK: checkpoint ${ckpt} is the branch head — fresh, banked ${bankedAgeMin ?? "?"}m ago.`,
		);
	else if (verdict === "behind")
		lines.push(
			`RESUME CHECK: checkpoint ${ckpt} is ${past} commit(s) behind head ${headSha} — reconcile those commits before continuing.`,
		);
	if (bankedAgeMin !== null && bankedAgeMin > 24 * 60)
		lines.push(
			`RESUME CHECK: capsule banked ${Math.round(bankedAgeMin / 60)}h ago — stale hand-off.`,
		);
	return {
		verdict,
		past,
		head: headSha,
		checkpoint: ckpt,
		bankedAgeMin,
		checkpointAgeMin: ckptAgeMin,
		dirty: opts.dirty ?? 0,
		lines,
	};
}
