// hooks/gates/scrub.ts — W236: the pre-commit/pre-push surface of
// lib/scrub.ts, wired into the PreToolUse(Bash) chain next to the secrets
// gate. Per git segment: `commit` scans the STAGED added lines, `push`
// scans the upstream→worktree added lines (content made while the gate was
// off still cannot leave). SUSPENDERS_SCRUB=0 disables. Git plumbing
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
import { gitSub, verb } from "./bash-hardening.ts";

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
		if (sub !== "commit" && sub !== "push") continue;
		const repoDir = segRepoDir(seg, segCwd);
		const inRepo = run("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: repoDir,
		}).ok;
		if (!inRepo) continue;
		const diffArgs = diffFor(sub, repoDir);
		if (!diffArgs) continue;
		const d = run("git", diffArgs, { cwd: repoDir });
		if (!d.ok) continue; // fail-inert on plumbing failure
		const found = scrubAddedLines(addedDiffLines(d.out), scrubRules());
		if (found.length > 0) deny(scrubDenyText(sub, found));
	}
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

const scrubDenyText = (sub: string, found: ScrubFinding[]): string =>
	`scrub-gate: ${found.length} finding(s) in ${sub === "commit" ? "STAGED content" : "content headed for the remote"} — blocked before it lands in history:\n` +
	`${findingsText(found)}\n` +
	`Scrub the content (rotate the credential if real). The only escape is the explicit marker \`scrub:allow\` on the offending line.`;
