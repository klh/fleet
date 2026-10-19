// packages/blam/bench/crash/fixture.ts — deterministic git fixture for the
// CRASH bench: a real temp repo (branch existence, MERGE_HEAD, two-parent
// commits and staged content are real git state), pinned dates/authors for
// byte-identical repeated runs, and a stand-in table replacing kill(pid,0)
// so liveness never touches the OS process world.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
	ok: boolean;
	out: string;
}

/** A scripted lane stand-in: kill() flips the table row (no OS procs). */
export interface StandinRow {
	pid: number;
	cmd: string;
	alive: boolean;
}

export interface Fixture {
	repo: string;
	fleet: string;
	procs: Map<number, StandinRow>;
	/** the root commit every scenario branches from */
	base: string;
	git(args: string[]): GitResult;
	dispose(): void;
}

/** Pinned env: fixed author/committer identity + dates make repeated runs
 * byte-identical (same shas); global/system git config is severed so no
 * machine config leaks into the fixture. */
function pinnedEnv(): Record<string, string> {
	const when = "2026-09-28T09:00:00 +0000";
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "blam",
		GIT_AUTHOR_EMAIL: "blam@bench",
		GIT_AUTHOR_DATE: when,
		GIT_COMMITTER_NAME: "blam",
		GIT_COMMITTER_EMAIL: "blam@bench",
		GIT_COMMITTER_DATE: when,
	};
}

/** The merge-runner command prefix the post-fix identity check expects
 * (mirrors the real .fleet/merge-active marker contract). */
export const RUNNER_CMD = "bun run merge-runner";

export function makeFixture(tag: string): Fixture {
	const root = mkdtempSync(join(tmpdir(), `blam-crash-${tag}-`));
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const env = pinnedEnv();
	const procs = new Map<number, StandinRow>();
	const git = (args: string[]): GitResult => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim();
		return { ok: p.exitCode === 0, out };
	};
	// seed: one root commit on main
	git(["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "base.txt"), "base\n");
	git(["add", "base.txt"]);
	git(["commit", "-q", "-m", "root"]);
	const base = git(["rev-parse", "HEAD"]).out;
	const fleet = join(repo, ".fleet");
	mkdirSync(join(fleet, "lanes"), { recursive: true });
	return {
		repo,
		fleet,
		procs,
		base,
		git,
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function existsGit(f: Fixture, path: string): boolean {
	return existsSync(join(f.repo, path));
}

/** Ground truth: does the branch ref exist on disk? */
export function branchExists(f: Fixture, branch: string): boolean {
	return f.git(["rev-parse", "--verify", "-q", `${branch}^{commit}`]).ok;
}

export function stagedFiles(f: Fixture): string[] {
	const r = f.git(["diff", "--name-only", "--cached"]);
	return r.ok && r.out.length > 0 ? r.out.split("\n") : [];
}

export function clearMergeState(f: Fixture): void {
	const mh = join(f.repo, ".git", "MERGE_HEAD");
	if (existsSync(mh)) rmSync(mh);
	f.git(["reset", "-q"]);
}

/** The .fleet/merge-active marker (real layout, real fields). */
export function writeMergeMarker(
	f: Fixture,
	marker: { pid: number; cmd: string; ts: number },
): void {
	writeFileSync(join(f.fleet, "merge-active"), JSON.stringify(marker));
}

export function readMergeMarker(
	f: Fixture,
): { pid: number; cmd: string; ts: number } | null {
	const p = join(f.fleet, "merge-active");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8")) as { pid: number; cmd: string; ts: number };
}

export function removeMergeMarker(f: Fixture): void {
	const p = join(f.fleet, "merge-active");
	if (existsSync(p)) rmSync(p);
}

/** Parents of HEAD (0 = no commits yet, 2 = a merge commit). */
export function headParents(f: Fixture): number {
	const r = f.git(["rev-list", "--parents", "-n", "1", "HEAD"]);
	if (!r.ok) return 0;
	return r.out.trim().split(" ").length - 1;
}
