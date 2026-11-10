import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";

// W2954 — the reference-transaction prepared-phase guard also protects a
// DONE item's own refs/heads/suspenders/<item>: reproduces the W2941/W2942
// post-close drift class at the hook boundary instead of relying on a later
// detection sweep.
const HOOKS = join(import.meta.dir, "../../../.githooks");
const worlds: ReturnType<typeof scratchWorld>[] = [];

const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};
const gitWithEnv = (
	repo: string,
	env: Record<string, string | undefined>,
	...args: string[]
) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};

test.afterAll(() => {
	for (const world of worlds.splice(0)) world.clean();
});

// scratch repo with the real .githooks active via an absolute hooksPath, so
// the lib-importing reference-transaction's relative imports resolve.
const itemWorld = (): ReturnType<typeof scratchWorld> => {
	const world = scratchWorld({ prefix: "fleet-w2954-" });
	worlds.push(world);
	git(world.repo, "branch", "-M", "main");
	git(world.repo, "config", "core.hooksPath", HOOKS);
	git(world.repo, "config", "user.name", "test");
	git(world.repo, "config", "user.email", "test@example.invalid");
	return world;
};

// a lane branch at one commit past main, returning its tip sha
const laneBranch = (
	world: ReturnType<typeof scratchWorld>,
	item: string,
): string => {
	git(world.repo, "checkout", "-b", `suspenders/${item}`);
	writeFileSync(join(world.repo, "change.txt"), "lane work\n");
	git(world.repo, "add", "change.txt");
	expect(git(world.repo, "commit", "-m", "lane").code).toBe(0);
	return git(world.repo, "rev-parse", "HEAD").out;
};

// seeds work_items DONE at `sha` for `item`, in the project the scratch repo
// identifies as; retries once for the sandbox's transient govdb ENOENT.
const seedDone = (
	world: ReturnType<typeof scratchWorld>,
	item: string,
	sha: string,
): void => {
	const seedChild = () =>
		Bun.spawnSync(
			[
				"bun",
				"-e",
				`
			import {openStore,projectIdentity} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"))};
			const db=openStore(), project=projectIdentity();
			db.query("INSERT OR REPLACE INTO work_items(project,id,title,state,result_sha,created_at,updated_at) VALUES (?,?,'fixture','DONE',?,?,?)").run(project,process.argv[1],process.argv[2],Date.now(),Date.now());
			db.close();
		`,
				item,
				sha,
			],
			{ cwd: world.repo, env: world.env, stdout: "pipe", stderr: "pipe" },
		);
	let seed = seedChild();
	for (let i = 0; seed.exitCode !== 0 && i < 2; i++) seed = seedChild();
	if (seed.exitCode !== 0)
		throw new Error(
			`seed child failed: ${seed.stderr.toString().slice(-1500)}`,
		);
};

test("W2954 ordinary pre-DONE commit on a suspenders/<item> branch succeeds", () => {
	const world = itemWorld();
	laneBranch(world, "WORD1");
	// never seeded DONE: the branch keeps moving as ordinary lane work
	writeFileSync(join(world.repo, "more.txt"), "more work\n");
	git(world.repo, "add", "more.txt");
	const commit = gitWithEnv(world.repo, world.env, "commit", "-m", "more");
	expect(commit.code).toBe(0);
});

test("W2954 post-close drift on a DONE branch refuses (W2941/W2942 reproduction)", () => {
	const world = itemWorld();
	const doneSha = laneBranch(world, "WDRIFT1");
	seedDone(world, "WDRIFT1", doneSha);
	writeFileSync(join(world.repo, "drift.txt"), "sweep or lane move\n");
	git(world.repo, "add", "drift.txt");
	const commit = gitWithEnv(
		world.repo,
		world.env,
		"commit",
		"-m",
		"post-close",
	);
	expect(commit.code).not.toBe(0);
	expect(`${commit.out}${commit.err}`).toContain("post-close drift");
	expect(git(world.repo, "rev-parse", "HEAD").out).toBe(doneSha);
});

test("W2954 a second drift from an already-drifted head still refuses", () => {
	const world = itemWorld();
	const doneSha = laneBranch(world, "WDRIFT2");
	seedDone(world, "WDRIFT2", doneSha);
	writeFileSync(join(world.repo, "drift1.txt"), "first drift\n");
	git(world.repo, "add", "drift1.txt");
	const tree1 = git(world.repo, "write-tree").out;
	const drift1 = git(
		world.repo,
		"commit-tree",
		"-p",
		doneSha,
		tree1,
		"-m",
		"drift1",
	).out;
	// reach an already-drifted head WITHOUT the guard (hooks disabled for
	// this one plumbing call) — simulates drift that happened some other
	// way; the guard's job is to stop it compounding, not to undo it
	const bypass = git(
		world.repo,
		"-c",
		"core.hooksPath=",
		"update-ref",
		"refs/heads/suspenders/WDRIFT2",
		drift1,
	);
	expect(bypass.code).toBe(0);
	writeFileSync(join(world.repo, "drift2.txt"), "second drift\n");
	git(world.repo, "add", "drift2.txt");
	const commit = gitWithEnv(world.repo, world.env, "commit", "-m", "drift2");
	expect(commit.code).not.toBe(0);
	expect(`${commit.out}${commit.err}`).toContain("post-close drift");
	expect(git(world.repo, "rev-parse", "HEAD").out).toBe(drift1);
});

test("W2954 re-anchoring exactly to the banked DONE sha is honored", () => {
	const world = itemWorld();
	const doneSha = laneBranch(world, "WREANCHOR");
	seedDone(world, "WREANCHOR", doneSha);
	writeFileSync(join(world.repo, "drift.txt"), "drift\n");
	git(world.repo, "add", "drift.txt");
	const tree = git(world.repo, "write-tree").out;
	const driftSha = git(
		world.repo,
		"commit-tree",
		"-p",
		doneSha,
		tree,
		"-m",
		"candidate drift",
	).out;
	expect(driftSha).not.toBe(doneSha);
	const toDrift = git(
		world.repo,
		"-c",
		"core.hooksPath=",
		"update-ref",
		"refs/heads/suspenders/WREANCHOR",
		driftSha,
		doneSha,
	);
	expect(toDrift.code).toBe(0);
	const reanchor = gitWithEnv(
		world.repo,
		world.env,
		"update-ref",
		"refs/heads/suspenders/WREANCHOR",
		doneSha,
		driftSha,
	);
	expect(reanchor.code).toBe(0);
	expect(
		git(world.repo, "rev-parse", "refs/heads/suspenders/WREANCHOR").out,
	).toBe(doneSha);
});

test("W2954 deleting a DONE branch (retirement) is honored", () => {
	const world = itemWorld();
	const doneSha = laneBranch(world, "WRETIRE");
	seedDone(world, "WRETIRE", doneSha);
	git(world.repo, "checkout", "main");
	const del = gitWithEnv(
		world.repo,
		world.env,
		"update-ref",
		"-d",
		"refs/heads/suspenders/WRETIRE",
	);
	expect(del.code).toBe(0);
	const gone = git(
		world.repo,
		"rev-parse",
		"--verify",
		"--quiet",
		"refs/heads/suspenders/WRETIRE",
	);
	expect(gone.code).not.toBe(0);
});

test("W2954 an unreachable store fails a DONE-branch update closed, not open", () => {
	const world = itemWorld();
	const doneSha = laneBranch(world, "WSTORE");
	seedDone(world, "WSTORE", doneSha);
	writeFileSync(join(world.repo, "drift.txt"), "drift\n");
	git(world.repo, "add", "drift.txt");
	// a HOME that is a regular file makes govdb's own
	// mkdirSync(REG(), {recursive:true}) fail deterministically (ENOTDIR)
	const brokenHome = `${world.home}-not-a-dir`;
	writeFileSync(brokenHome, "not a directory\n");
	const commit = gitWithEnv(
		world.repo,
		{ ...world.env, HOME: brokenHome },
		"commit",
		"-m",
		"blind",
	);
	expect(commit.code).not.toBe(0);
	expect(`${commit.out}${commit.err}`).toContain("store unavailable");
	rmSync(brokenHome, { force: true });
});
