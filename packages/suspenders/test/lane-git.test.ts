// W835 — lane-git observation lib: budgeted git probes, per-field
// null-degradation, the merge-ready gate, and the text badge. Hermetic:
// fixture repos under a mkdtemp root, no db, no env coupling.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitBadge,
	gitObservation,
	mergeReady,
	mergeReadyWhy,
	resetLaneGitMemo,
} from "../hooks/lib/lanes/lane-git.ts";

const root = mkdtempSync(join(tmpdir(), "lane-git-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// base commit pushed to a bare origin, then a lane branch with one commit
// ahead of the integration base — the real worktree shape (lanes never sit
// on main)
function readyRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	const sh = (...args: string[]) =>
		Bun.spawnSync(["git", ...args], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
	sh("init", "-q", "-b", "main");
	sh("config", "user.email", "t@t.invalid");
	sh("config", "user.name", "t");
	writeFileSync(join(dir, "a.txt"), "one\n");
	sh("add", ".");
	sh("commit", "-qm", "base");
	const bare = join(root, `${name}-origin.git`);
	Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare], {
		stdout: "pipe",
		stderr: "pipe",
	});
	sh("remote", "add", "origin", bare);
	sh("push", "-q", "-u", "origin", "main");
	sh("checkout", "-q", "-b", "lane");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	sh("add", ".");
	sh("commit", "-qm", "ahead");
	return dir;
}

describe("gitObservation", () => {
	test("clean lane ahead of the integration base reads merge-ready", () => {
		const wt = readyRepo("ready");
		resetLaneGitMemo();
		const obs = gitObservation(wt);
		expect(obs.branch).toBe("lane");
		expect(obs.headOid).toMatch(/^[0-9a-f]{40,64}$/);
		expect(obs.dirty).toBe(false);
		expect(obs.diffStats).toEqual({ added: 0, deleted: 0 });
		expect(obs.ahead).toBe(1);
		expect(obs.behind).toBeNull();
		expect(obs.conflicted).toBe(0);
		expect(obs.mergeReady).toBe(true);
		expect(gitBadge(obs)).toBe(" · merge-ready");
	});

	test("dirty worktree reads not merge-ready with a reason", () => {
		const wt = readyRepo("dirty");
		writeFileSync(join(wt, "b.txt"), "x\n");
		resetLaneGitMemo();
		const obs = gitObservation(wt);
		expect(obs.dirty).toBe(true);
		expect(obs.mergeReady).toBe(false);
		expect(gitBadge(obs)).toBe(" · not merge-ready (dirty)");
	});

	test("untracked count is gitignore-respecting", () => {
		const wt = readyRepo("ignored");
		writeFileSync(join(wt, ".gitignore"), "secret.txt\n");
		writeFileSync(join(wt, "seen.txt"), "s\n");
		writeFileSync(join(wt, "secret.txt"), "s\n");
		resetLaneGitMemo();
		const obs = gitObservation(wt);
		expect(obs.untracked).toBe(2); // seen.txt + the .gitignore itself
		expect(obs.dirty).toBe(true);
		expect(obs.mergeReady).toBe(false);
	});

	test("branch sitting at main with no upstream reads ahead 0 — not merge-ready", () => {
		const dir = join(root, "no-upstream");
		mkdirSync(dir);
		const sh = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
		sh("init", "-q", "-b", "main");
		sh("config", "user.email", "t@t.invalid");
		sh("config", "user.name", "t");
		writeFileSync(join(dir, "a.txt"), "one\n");
		sh("add", ".");
		sh("commit", "-qm", "base");
		resetLaneGitMemo();
		const obs = gitObservation(dir);
		// W1279: ahead measures main..HEAD (0 here), not upstream sync (null)
		expect(obs.ahead).toBe(0);
		expect(obs.behind).toBeNull();
		expect(obs.mergeReady).toBe(false);
		expect(gitBadge(obs)).toBe(" · not merge-ready (not ahead)");
	});

	test("pushed lane with upstream-synced head still reads merge-ready (W1285)", () => {
		const wt = readyRepo("pushed");
		const sh = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], {
				cwd: wt,
				stdout: "pipe",
				stderr: "pipe",
			});
		// push the lane branch — branch.ab now reads +0 -0 while main..HEAD = 1
		sh("push", "-q", "-u", "origin", "lane");
		resetLaneGitMemo();
		const obs = gitObservation(wt);
		expect(obs.ahead).toBe(1);
		expect(obs.behind).toBe(0);
		expect(obs.mergeReady).toBe(true);
		expect(gitBadge(obs)).toBe(" · merge-ready");
	});
});

describe("degradation", () => {
	test("non-repo dir reads all-null (record still parses)", () => {
		resetLaneGitMemo();
		const obs = gitObservation(root);
		expect(obs.branch).toBeNull();
		expect(obs.headOid).toBeNull();
		expect(obs.dirty).toBeNull();
		expect(obs.diffStats).toBeNull();
		expect(obs.untracked).toBeNull();
		expect(obs.ahead).toBeNull();
		expect(obs.behind).toBeNull();
		expect(obs.conflicted).toBeNull();
		expect(obs.mergeReady).toBeNull();
	});
});

describe("conflict probe", () => {
	test("a conflicted merge counts unmerged entries and gates false", () => {
		const dir = join(root, "conflict");
		mkdirSync(dir);
		const sh = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
		sh("init", "-q", "-b", "main");
		sh("config", "user.email", "t@t.invalid");
		sh("config", "user.name", "t");
		writeFileSync(join(dir, "a.txt"), "a\n");
		sh("add", ".");
		sh("commit", "-qm", "base");
		const bare = join(root, "conflict-origin.git");
		Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare], {
			stdout: "pipe",
			stderr: "pipe",
		});
		sh("remote", "add", "origin", bare);
		sh("push", "-q", "-u", "origin", "main");
		sh("checkout", "-q", "-b", "lane");
		writeFileSync(join(dir, "a.txt"), "side\n");
		sh("add", ".");
		sh("commit", "-qm", "side");
		sh("checkout", "-q", "main");
		writeFileSync(join(dir, "a.txt"), "main\n");
		sh("add", ".");
		sh("commit", "-qm", "main-side");
		// the lane absorbs base's divergence — the conflict lands on the lane
		sh("checkout", "-q", "lane");
		sh("merge", "--no-edit", "main");
		resetLaneGitMemo();
		const obs = gitObservation(dir);
		expect(obs.conflicted).toBe(1);
		expect(obs.dirty).toBe(true);
		expect(obs.mergeReady).toBe(false);
		expect(gitBadge(obs)).toBe(" · not merge-ready (dirty, 1 conflicted)");
	});
});

describe("memo", () => {
	test("serves the same record inside the TTL window", () => {
		const wt = readyRepo("memo");
		resetLaneGitMemo();
		const first = gitObservation(wt);
		const second = gitObservation(wt);
		expect(second).toBe(first);
	});
	test("reset forces a fresh observe", () => {
		const wt = readyRepo("memo2");
		resetLaneGitMemo();
		const first = gitObservation(wt);
		resetLaneGitMemo();
		expect(gitObservation(wt)).not.toBe(first);
	});
});

describe("mergeReady gate + reasons", () => {
	test("null terms never invent a verdict", () => {
		expect(mergeReady({ dirty: null, ahead: 3, conflicted: 0 })).toBeNull();
		expect(mergeReady({ dirty: false, ahead: null, conflicted: 0 })).toBeNull();
		expect(mergeReady({ dirty: false, ahead: 3, conflicted: null })).toBeNull();
	});
	test("gate truth table", () => {
		expect(mergeReady({ dirty: false, ahead: 1, conflicted: 0 })).toBe(true);
		expect(mergeReady({ dirty: true, ahead: 1, conflicted: 0 })).toBe(false);
		expect(mergeReady({ dirty: false, ahead: 0, conflicted: 0 })).toBe(false);
		expect(mergeReady({ dirty: false, ahead: 1, conflicted: 2 })).toBe(false);
	});
	test("mergeReadyWhy enumerates each failing term", () => {
		expect(mergeReadyWhy({ dirty: true, ahead: 0, conflicted: 2 })).toEqual([
			"dirty",
			"2 conflicted",
			"not ahead",
		]);
		expect(mergeReadyWhy({ dirty: false, ahead: 1, conflicted: 0 })).toEqual(
			[],
		);
	});
});
