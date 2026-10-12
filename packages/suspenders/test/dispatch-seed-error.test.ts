// test/dispatch-seed-error.test.ts — W695.1: the dispatch output and the
// lane registry row carry the starter-seed failure (exit code + stderr tail
// + phase marker + belt-front preflight verdict). E2E over the real
// dispatch-next CLI in a scratch repo/HOME: the executor stub sleeps through
// the seed turn, so the seed yields no session id, dispatch logs SEED FAILED
// and falls back to a cold start whose registry row carries the seedError.
import { describe, expect, test, afterAll } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "w6951-dispatch-home-"));
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "w6951-dispatch-repo-")));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = {
	...process.env,
	HOME,
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_LANE_MAX_ATTEMPTS: "3",
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: one commit so the lane worktree has a base
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const tool = (
	bin: string,
	...args: string[]
): { out: string; code: number } => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString(), code: p.exitCode ?? 1 };
};

const dispatchWith = (
	extra: Record<string, string | undefined>,
	...args: string[]
): { out: string; code: number } => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{ cwd: REPO, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	return { out: p.stdout.toString(), code: p.exitCode ?? 1 };
};

describe("W695.1 starter-seed error propagation", () => {
	test("seed failure surfaces exit code + stderr tail + preflight + registry row", async () => {
		const added = tool("work.ts", "add", "seed error propagation probe");
		const id = added.out.match(/W\d+/)?.[0] ?? "";
		expect(id).toBeTruthy();
		const sleepExec = join(HOME, "sleep-claude");
		writeFileSync(sleepExec, "#!/bin/sh\nsleep 2\n");
		chmodSync(sleepExec, 0o700);
		const result = dispatchWith(
			{
				SUSPENDERS_CLAUDE_BIN: sleepExec,
				SUSPENDERS_LANE_STARTER: "on",
			},
			"--item",
			id,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.out).toContain(`SEED FAILED ${id}`);
		expect(result.out).toMatch(/starter-seed, code \d+/);
		expect(result.out).toContain("seed fallback:");
		const lanes = JSON.parse(
			readFileSync(join(REPO, ".fleet", "lanes.json"), "utf8"),
		) as Array<{
			item: string;
			seedError?: { phase: string; code: number; preflight?: string };
		}>;
		const mine = lanes.find((l) => l.item === id);
		expect(mine?.seedError?.phase).toBe("starter-seed");
		expect(mine?.seedError?.preflight).toBeUndefined();
	}, 30000);
});
