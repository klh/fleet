// test/dep-merge-gate.test.ts — W1206: the shared bounded exact-main ancestor
// snapshot behind shaOnMain. Safety cases pin the semantics the snapshot must
// NOT move: hits are exact positives, misses fall through to the per-SHA
// merge-base probe so the verified negative (the W60 dep gate), the
// unknown/error fail-open, shallow-clone behavior and integration ref changes
// read byte-identical to the fork-per-sha probe they replace.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shaOnMain, unmergedDeps } from "../hooks/lib/dep-merge-gate.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString()}`);
	return p.stdout?.toString().trim() ?? "";
};
const scratchRepo = (): { dir: string; project: string; sha: string } => {
	const d = mkdtempSync(join(tmpdir(), "w1206-gate-"));
	dirs.push(d);
	Bun.spawnSync(["git", "init", "-q", "-b", "main", d]);
	writeFileSync(join(d, "f.txt"), "x\n");
	git(d, "add", ".");
	git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "a");
	return {
		dir: d,
		project: `${d}/.git`,
		sha: git(d, "rev-parse", "HEAD"),
	};
};
// a commit off main's tip: known to git, NOT an ancestor of main (until main
// merges it)
const laneSha = (d: string, msg: string): string => {
	git(d, "checkout", "-q", "-b", `lane-${msg.replace(/\s/g, "-")}`);
	writeFileSync(join(d, "lane.txt"), msg);
	git(d, "add", ".");
	git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg);
	return git(d, "rev-parse", "HEAD");
};
const onMain = (d: string, msg: string): string => {
	git(d, "checkout", "-q", "main");
	writeFileSync(join(d, "main.txt"), msg);
	git(d, "add", ".");
	git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg);
	return git(d, "rev-parse", "HEAD");
};

test("a merged sha is an exact positive straight off the snapshot", () => {
	const r = scratchRepo();
	expect(shaOnMain(r.sha, r.project)).toBe(true);
});

test("an unmerged lane sha is a verified negative that gates deps", () => {
	const r = scratchRepo();
	const lane = laneSha(r.dir, "wip");
	// snapshot misses the lane sha — the probe must still prove the negative
	expect(shaOnMain(lane, r.project)).toBe(false);
	expect(
		unmergedDeps(
			[{ depends_on: "W9", state: "DONE", result_sha: lane }],
			r.project,
		),
	).toEqual([{ dep: "W9", sha: lane }]);
	// and a merged dep never gates
	expect(
		unmergedDeps(
			[{ depends_on: "W8", state: "DONE", result_sha: r.sha }],
			r.project,
		).length,
	).toBe(0);
});

test("an unknown sha reads cannot-know, never false", () => {
	const r = scratchRepo();
	// the snapshot misses it; the probe's exit >1 must stay null (fail-open)
	expect(shaOnMain("f".repeat(40), r.project)).toBeNull();
});

test("a repo without a main ref fails open", () => {
	const d = mkdtempSync(join(tmpdir(), "w1206-gate-nomain-"));
	dirs.push(d);
	Bun.spawnSync(["git", "init", "-q", "-b", "trunk", d]);
	writeFileSync(join(d, "f.txt"), "x\n");
	git(d, "add", ".");
	git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "a");
	const sha = git(d, "rev-parse", "HEAD");
	// no snapshot (rev-list main errors) and the probe's exit >1 stays null
	expect(shaOnMain(sha, `${d}/.git`)).toBeNull();
});

test("integration ref changes stay exact: post-snapshot merges verify true", () => {
	const r = scratchRepo();
	const lane = laneSha(r.dir, "late merge");
	// snapshot era: the lane sha is a proven negative
	expect(shaOnMain(lane, r.project)).toBe(false);
	// main advances past the snapshot (merge the lane branch)
	git(r.dir, "checkout", "-q", "main");
	git(r.dir, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-ff", "-q", "-m", "merge lane", lane);
	// a sha never probed before reads the EXACT current answer off the
	// fallback probe even though the snapshot predates the merge
	const fresh = onMain(r.dir, "post-snapshot");
	expect(shaOnMain(fresh, r.project)).toBe(true);
	// the lane sha keeps its per-sha probe memo (pre-existing W60 semantics —
	// the fork-per-sha code memoized negatives identically)
	expect(shaOnMain(lane, r.project)).toBe(false);
});

test("shallow clones read cannot-know beyond the graft, never false", () => {
	const a = scratchRepo();
	onMain(a.dir, "second");
	const b = mkdtempSync(join(tmpdir(), "w1206-gate-shallow-"));
	dirs.push(b);
	git(`${b}/..`, "clone", "-q", "--depth", "1", `file://${a.dir}`, b);
	const tip = git(b, "rev-parse", "HEAD");
	// the parent exists only in the full clone — depth 1 grafts it away
	const parent = git(a.dir, "rev-parse", "HEAD~1");
	// the tip is shallow-visible: exact positive off the snapshot
	expect(shaOnMain(tip, `${b}/.git`)).toBe(true);
	// the parent lies beyond the shallow boundary: absent from the snapshot,
	// and the probe cannot resolve it either — cannot know, never a negative
	expect(shaOnMain(parent, `${b}/.git`)).toBeNull();
});

test("no worktree for the project fails open", () => {
	expect(shaOnMain("a".repeat(40), "/not/a/git/dir")).toBeNull();
});
