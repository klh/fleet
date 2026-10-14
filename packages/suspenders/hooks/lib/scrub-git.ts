// hooks/lib/scrub-git.ts — W708 (W694 H2): the git-backed scans behind the
// scrub gate's commit/push faces. lib/scrub.ts stays the pure scanner; this
// module owns the plumbing it was blind to:
//   - per-commit range scanning: the net remote..local tree-diff never sees
//     an add-then-remove inside the range, but the leak ships in history;
//   - first-push base: with no upstream the pre-push range is empty, so the
//     scan falls back to merge-base(default branch, tip)..tip, else the
//     empty tree (everything reachable from tip);
//   - binary/NUL blobs: git diffs emit no hunks for them — any binary file
//     the stage or a range commit touches is scanned whole (latin1).
import { run } from "./run.ts";
import {
	addedDiffLines,
	scrubAddedLines,
	scrubBuffer,
	scrubRules,
	type ScrubFinding,
} from "./scrub.ts";

// the virtual empty-tree object every repo resolves — root-commit and
// no-default-branch diffs diff against it
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_BRANCHES = ["origin/main", "origin/master", "main", "master"];

const git = (args: string[], repoDir: string) =>
	run("git", args, { cwd: repoDir });

// byte-faithful blob read — run() is utf8, NUL bytes would not survive
const gitBlob = (
	args: string[],
	repoDir: string,
): { ok: boolean; buf: Uint8Array } => {
	const r = Bun.spawnSync(["git", ...args], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { ok: r.exitCode === 0, buf: r.stdout };
};

// one blob whole-buffer scan (byte-faithful latin1); spec is any
// <tree-ish>:<path> — staged (`:path`), commit (`sha:path`), candidate
// tree (`tree-sha:path`). Unreadable/deleted blob → nothing to scan.
export const blobFindings = (
	repoDir: string,
	spec: string,
	file: string,
): ScrubFinding[] => {
	const b = gitBlob(["cat-file", "blob", spec], repoDir);
	if (!b.ok) return [];
	return scrubBuffer(b.buf, scrubRules(), file);
};

// numstat rows with `-` added AND `-` deleted counts name binary files
export const binaryPaths = (numstat: string): string[] =>
	numstat
		.split("\n")
		.map((l) => l.split("\t"))
		.filter((t) => t.length >= 3 && t[0] === "-" && t[1] === "-")
		.map((t) => t.slice(2).join("\t"));

// staged binary blobs: the --cached diff emits no hunks for binary files,
// so the numstat `- -` rows name them and the staged blob scans whole.
export function stagedBinaryFindings(repoDir: string): ScrubFinding[] {
	const d = git(["diff", "--cached", "--numstat"], repoDir);
	if (!d.ok) return [];
	return binaryPaths(d.out).flatMap((p) => blobFindings(repoDir, `:${p}`, p));
}

// per-commit scan of base..tip: each commit's own -U0 diff (an
// add-then-remove inside the range is visible to the commit that adds the
// leak — the net tree-diff is blind to it) plus each binary file the commit
// touches, scanned whole. Fail-inert on plumbing failures.
export function commitRangeFindings(
	repoDir: string,
	base: string,
	tip: string,
): ScrubFinding[] {
	// EMPTY_TREE is a tree-ish — rev-list only walks commits, so a degenerate
	// base lists every reachable commit from the tip instead.
	const range = base === EMPTY_TREE ? tip : `${base}..${tip}`;
	const rl = git(["rev-list", range], repoDir);
	if (!rl.ok) return [];
	const out: ScrubFinding[] = [];
	for (const raw of rl.out.split("\n")) {
		const sha = raw.trim();
		if (!sha) continue;
		let d = git(["diff", `${sha}^`, sha, "-U0", "--no-color"], repoDir);
		if (!d.ok) d = git(["diff", EMPTY_TREE, sha, "-U0", "--no-color"], repoDir); // root commit
		if (d.ok) out.push(...scrubAddedLines(addedDiffLines(d.out), scrubRules()));
		const nd = git(
			["diff-tree", "-r", "--root", "--no-commit-id", "--numstat", sha],
			repoDir,
		);
		if (nd.ok)
			for (const p of binaryPaths(nd.out))
				out.push(...blobFindings(repoDir, `${sha}:${p}`, p));
	}
	return out;
}

// the base a first push (no upstream) scans from: merge-base with the
// default branch when one resolves, else the empty tree — a new branch's
// first push used to scan nothing at all.
export function firstPushBase(repoDir: string, tip: string): string {
	for (const ref of DEFAULT_BRANCHES) {
		const c = git(
			["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			repoDir,
		);
		if (!c.ok) continue;
		const mb = git(["merge-base", ref, tip], repoDir);
		if (!mb.ok || !mb.out.trim()) continue;
		// pushed branch IS this default branch: merge-base == tip empties the
		// base..tip range (glm-5.3 review) — fall through so a default-branch
		// first push scans the whole tip via the EMPTY_TREE leg.
		if (mb.out.trim() === tip.trim()) continue;
		return mb.out.trim();
	}
	return EMPTY_TREE;
}
