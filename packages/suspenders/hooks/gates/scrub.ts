// hooks/gates/scrub.ts — W236: the pre-commit/pre-push surface of
// lib/scrub.ts, wired into the PreToolUse(Bash) chain next to the secrets
// gate. Per git segment: `commit` scans the STAGED added lines, `push`
// scans the upstream→worktree added lines, and `merge` scans what the merge
// would add (a clean merge auto-commits with NO hook — W694 H1; content
// made while the gate was off still cannot leave). SUSPENDERS_SCRUB=0
// disables. Git plumbing
// failure is fail-inert (a broken diff never blocks); findings deny with
// file:line + the marker recipe.
import { deny } from "../lib/hookio.ts";
import { run } from "../lib/run.ts";
import {
	addedDiffLines,
	findingsText,
	scrubAddedLines,
	scrubRules,
	type ScrubFinding,
} from "../lib/scrub.ts";
import { gitSub, gitSubIndex, verb } from "./bash-hardening.ts";

// repo dir a git segment operates on — -C <path> / --git-dir=<path>
// override the segment cwd (cd-tracking folded into segCwd by the caller,
// the secrets-gate pattern).
function segRepoDir(seg: string[], segCwd: string): string {
	let dir = segCwd;
	const c = seg.indexOf("-C");
	if (c !== -1 && seg[c + 1])
		dir = seg[c + 1].startsWith("/")
			? String(seg[c + 1])
			: `${segCwd}/${seg[c + 1]}`;
	const gd = seg.find((a) => a.startsWith("--git-dir="));
	if (gd) dir = gd.slice("--git-dir=".length);
	return dir;
}

export function scrubGateSegments(segs: string[][], cwd: string): void {
	if (process.env.SUSPENDERS_SCRUB === "0") return; // owner kill switch
	let segCwd = cwd;
	for (const seg of segs) {
		const v = verb(seg);
		if (v === "cd") {
			const t = seg[seg.length - 1];
			if (t && !t.startsWith("<op"))
				segCwd = t.startsWith("/") ? String(t) : `${segCwd}/${t}`;
			continue;
		}
		if (v !== "git") continue;
		const sub = gitSub(seg);
		if (sub !== "commit" && sub !== "push" && sub !== "merge") continue;
		const repoDir = segRepoDir(seg, segCwd);
		const inRepo = run("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: repoDir,
		}).ok;
		if (!inRepo) continue;
		if (sub === "merge") {
			const found = mergeFindings(seg, gitSubIndex(seg).idx, repoDir);
			if (found.length > 0)
				deny(scrubDenyText("content a MERGE would add", found));
			continue;
		}
		const diffArgs = diffFor(sub, repoDir);
		if (!diffArgs) continue;
		const d = run("git", diffArgs, { cwd: repoDir });
		if (!d.ok) continue; // fail-inert on plumbing failure
		const found = scrubAddedLines(addedDiffLines(d.out), scrubRules());
		if (found.length > 0) deny(scrubDenyText(scannedSet(sub), found));
	}
}

const scannedSet = (sub: "commit" | "push"): string =>
	sub === "commit" ? "STAGED content" : "content headed for the remote";

// the merge leg (W694 H1): a clean `git merge` auto-commits and runs NO
// hook — leak content lands without the commit surface ever seeing it.
// Pre-merge, scan the three-dot diff (merge-base(HEAD, ref)..ref) — exactly
// what the merge would add. Unresolvable refs fail inert, never block.
const MERGE_VALUE_OPTS = new Set([
	"-m",
	"--message",
	"-F",
	"--file",
	"-s",
	"--strategy",
	"-X",
	"--strategy-option",
	"--into-name",
	"--log",
]);
const MERGE_SKIP = new Set(["--abort", "--continue", "--quit"]);

function mergeFindings(
	seg: string[],
	subIdx: number,
	repoDir: string,
): ScrubFinding[] {
	const out: ScrubFinding[] = [];
	if (seg.some((t) => MERGE_SKIP.has(t))) return out;
	for (let i = subIdx + 1; i < seg.length; i++) {
		const t = seg[i];
		if (MERGE_SKIP.has(t)) continue;
		if (MERGE_VALUE_OPTS.has(t)) {
			i++; // value-taking flag: its value is never a ref
			continue;
		}
		if (t.startsWith("-")) continue;
		const sha = run(
			"git",
			["rev-parse", "--verify", "--quiet", `${t}^{commit}`],
			{ cwd: repoDir },
		);
		if (!sha.ok) continue; // unresolvable ref → fail inert
		const d = run(
			"git",
			["diff", `HEAD...${sha.out.trim()}`, "-U0", "--no-color"],
			{ cwd: repoDir },
		);
		if (!d.ok) continue; // plumbing failure → fail inert
		out.push(...scrubAddedLines(addedDiffLines(d.out), scrubRules()));
	}
	return out;
}

// the diff covering what a commit/push would ADD to history: commit → the
// staged changes; push → the upstream…worktree added lines (null when no
// upstream — the commit surface already gated that content).
function diffFor(sub: string, repoDir: string): string[] | null {
	if (sub === "commit") return ["diff", "--cached", "-U0", "--no-color"];
	const up = run(
		"git",
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		{ cwd: repoDir },
	);
	if (!up.ok || !up.out.trim()) return null;
	return ["diff", `${up.out.trim()}...`, "-U0", "--no-color"];
}

const scrubDenyText = (what: string, found: ScrubFinding[]): string =>
	`scrub-gate: ${found.length} finding(s) in ${what} — blocked before it lands in history:\n` +
	`${findingsText(found)}\n` +
	`Scrub the content (rotate the credential if real). The only escape is the explicit marker \`scrub:allow\` on the offending line.`;
