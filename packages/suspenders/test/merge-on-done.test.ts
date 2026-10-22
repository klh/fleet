// merge-on-done.test.ts — W249: the ladder reacts to `work done` instead of
// the next watch cycle. Contract: a DISPATCHED lane's close (lane entry in
// .fleet/lanes.json) spawns a detached `fleet-loop flush --item <id> --await
// <secs>` child that waits out the closing lane's exit and merges seconds
// later — branch retired, work.landed on the bus. A manual close (no lane
// entry) spawns NOTHING. flush --item sweeps the resolved branch even
// off-glob; a lane still alive at the await deadline defers loudly
// (FLUSH-AWAIT-TIMEOUT) and the daemon sweep owns the branch.
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	awaitLaneExit,
	resolveItemBranch,
	triggerMergeOnDone,
} from "../hooks/lib/merge-on-done.ts";

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const WORK = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
const GRACE = { FLEET_UNTRACKED_GRACE_MS: "0" };

const g = (repo: string, args: string[], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

const testEnv = (repo: string) => ({
	...process.env,
	...GRACE,
	HOME: join(repo, ".test-home"),
	GOVERNOR_STORE_URL: "",
});

const run = (repo: string, args: string[]) => {
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: repo,
		env: testEnv(repo),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`,
	};
};

const log = (repo: string): string => {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
};

const waitFor = async (
	cond: () => boolean,
	ms: number,
	step = 250,
): Promise<boolean> => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await Bun.sleep(step);
	}
	return cond();
};

const base = async (): Promise<string> => {
	const dir = join(
		tmpdir(),
		`w249-merge-on-done-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	expect(g(dir, ["init", "-b", "main"]).exitCode).toBe(0);
	g(dir, ["config", "user.email", "t@threads.dk"]);
	g(dir, ["config", "user.name", "t"]);
	await Bun.write(Bun.file(join(dir, "f.txt")), "one\n");
	g(dir, ["add", "-A"]);
	expect(g(dir, ["commit", "-m", "base"]).exitCode).toBe(0);
	return dir;
};

// lane-shaped branch + an 11-min-old registry entry (past the retire
// recently-launched grace) so the flush's retire lifecycle can complete
const laneBranch = async (repo: string, item: string, sid: string) => {
	const wt = join(repo, ".worktrees", item);
	expect(
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]).exitCode,
	).toBe(0);
	await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
	g(repo, ["add", "-A"], wt);
	expect(g(repo, ["commit", "-m", `lane change ${item}`], wt).exitCode).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lanes.json"),
		JSON.stringify([
			{
				sid,
				item,
				branch: `suspenders/${item}`,
				pid: 999_998,
				worktree: wt,
				host: hostname(),
				launchedAt: Date.now() - 11 * 60_000,
			},
		]),
	);
	return g(repo, ["rev-parse", "HEAD"], wt).stdout.toString().trim();
};

const SUMMARY =
	"seed closure paragraph for the merge-on-done ladder test: the plane itself records the completion evidence, long enough for the summary validator.";

const mint = (repo: string): string => {
	const add = run(repo, [WORK, "add", "flush item", "--by", "lane"]);
	if (add.code !== 0) throw new Error(`work add failed: ${add.out}`);
	const m = /\bW\d+\b/.exec(add.out);
	if (!m) throw new Error(`no item id in: ${add.out}`);
	return m[0];
};

// close via the plane itself so the detached flush trigger runs exactly as
// production invokes it (work done → triggerMergeOnDone → flush child)
const close = (repo: string, item: string, sha: string) => {
	const take = run(repo, [WORK, "take", item, "--as", "w249lane"]);
	expect(take.code).toBe(0);
	const tok = /claim token: ([0-9a-f]{48})/.exec(take.out)?.[1];
	const done = run(repo, [
		WORK,
		"done",
		item,
		"--as",
		"w249lane",
		"--sha",
		sha,
		"--summary",
		SUMMARY,
		...(tok ? ["--token", tok] : []),
	]);
	if (done.code !== 0) throw new Error(`work done failed: ${done.out}`);
};

const flush = (repo: string, extra: string[] = []) =>
	run(repo, [
		LOOP,
		"flush",
		"--repo",
		repo,
		"--glob",
		"suspenders/*",
		...extra,
	]);

const events = (repo: string, kind: string): number => {
	const db = new Database(
		join(repo, ".test-home", ".cache", "claude-governor", "governor.db"),
	);
	try {
		return (
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE source = 'fleet-loop' AND kind = ?",
				)
				.get(kind) as { n: number }
		).n;
	} finally {
		db.close();
	}
};

const branchGone = (repo: string, item: string) =>
	g(repo, ["branch", "--list", `suspenders/${item}`])
		.stdout.toString()
		.trim() === "";

describe("merge-on-done trigger (W249)", () => {
	test("a dispatched lane's close fires the ladder: merged + retired seconds after done", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item, "w249lane");
		close(repo, item, head);
		// RETIRED, not MERGED: the merge line lands ~0.2s before the branch delete
		expect(
			await waitFor(
				() => log(repo).includes(`RETIRED suspenders/${item}`),
				15_000,
			),
		).toBe(true);
		expect(branchGone(repo, item)).toBe(true);
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			`Merge suspenders/${item}`,
		);
		rmSync(repo, { recursive: true, force: true });
	});

	test("manual close (no lane entry) spawns nothing — daemon owns the merge", async () => {
		const repo = await base();
		const item = mint(repo);
		await laneBranch(repo, item, "w249lane");
		// strip the registry: the closer is an operator, not a dispatched lane
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		close(repo, item, g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim());
		await Bun.sleep(2_000);
		expect(log(repo)).toBe("");
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("triggerMergeOnDone kill-switch: FLEET_MERGE_ON_DONE=0 spawns nothing", async () => {
		const repo = await base();
		const item = mint(repo);
		await laneBranch(repo, item, "w249lane");
		const prev = process.env.FLEET_MERGE_ON_DONE;
		process.env.FLEET_MERGE_ON_DONE = "0";
		try {
			expect(triggerMergeOnDone(repo, item)).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.FLEET_MERGE_ON_DONE;
			else process.env.FLEET_MERGE_ON_DONE = prev;
		}
		expect(log(repo)).toBe("");
		rmSync(repo, { recursive: true, force: true });
	});
});

describe("flush --item gate (W249)", () => {
	test("sweeps the resolved branch even off-glob (suffix fallback)", async () => {
		const repo = await base();
		const item = mint(repo);
		const wt = join(repo, ".worktrees", item);
		expect(g(repo, ["worktree", "add", "-b", `odd/${item}`, wt]).exitCode).toBe(
			0,
		);
		await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
		g(repo, ["add", "-A"], wt);
		expect(g(repo, ["commit", "-m", `lane change ${item}`], wt).exitCode).toBe(
			0,
		);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		const head = g(repo, ["rev-parse", "HEAD"], wt).stdout.toString().trim();
		close(repo, item, head);
		const r = run(repo, [
			LOOP,
			"flush",
			"--repo",
			repo,
			"--glob",
			"suspenders/*",
			"--item",
			item,
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`MERGED odd/${item}`);
		expect(events(repo, "work.landed")).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("lane alive at the await deadline defers loudly, then merges once exited", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item, "w249lane");
		// a fresh fake transcript under the redirected HOME keeps the lane's
		// claimant-transcript liveness TRUE through the first (short) await
		const projects = join(repo, ".test-home", ".claude", "projects", "p");
		mkdirSync(projects, { recursive: true });
		const transcript = join(projects, "w249lane.jsonl");
		await Bun.write(Bun.file(transcript), "fake\n");
		close(repo, item, head);
		const r = run(repo, [
			LOOP,
			"flush",
			"--repo",
			repo,
			"--item",
			item,
			"--await",
			"1",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`FLUSH-AWAIT-TIMEOUT suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(false);
		rmSync(transcript);
		const r2 = flush(repo, ["--item", item]);
		expect(r2.code).toBe(0);
		expect(log(repo)).toContain(`MERGED suspenders/${item}`);
		rmSync(repo, { recursive: true, force: true });
	});
});

describe("merge-on-done units (W249)", () => {
	test("resolveItemBranch: registry entry wins, suffix fallback, null when unknown", async () => {
		const repo = await base();
		expect(resolveItemBranch(repo, "Wnone")).toBeNull();
		const item = mint(repo);
		const wt = join(repo, ".worktrees", item);
		g(repo, ["worktree", "add", "-b", `odd/${item}`, wt]);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		expect(resolveItemBranch(repo, item)).toBe(`odd/${item}`);
		writeFileSync(
			join(repo, ".fleet", "lanes.json"),
			JSON.stringify([{ sid: "s", item, branch: `reg/${item}` }]),
		);
		expect(resolveItemBranch(repo, item)).toBe(`reg/${item}`);
		rmSync(repo, { recursive: true, force: true });
	});

	test("awaitLaneExit: dead lane ready; alive past deadline timeout; gone when branch vanishes", async () => {
		const repo = await base();
		const item = mint(repo);
		const wt = join(repo, ".worktrees", item);
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		expect(
			await awaitLaneExit(repo, `suspenders/${item}`, 5_000, () => false),
		).toBe("ready");
		expect(
			await awaitLaneExit(repo, `suspenders/${item}`, 60, () => true, 20),
		).toBe("timeout");
		setTimeout(() => {
			g(repo, ["worktree", "remove", "--force", wt]);
			g(repo, ["branch", "-D", `suspenders/${item}`]);
		}, 50);
		expect(
			await awaitLaneExit(repo, `suspenders/${item}`, 5_000, () => true, 20),
		).toBe("gone");
		rmSync(repo, { recursive: true, force: true });
	});

	// W1124.16: the wait authorizes a merge — only a PROVEN-dead lane (explicit
	// false) reads ready; an unknown probe (null) is never death: it waits out
	// the deadline and lands as timeout (the loud defer).
	test("awaitLaneExit: UNKNOWN (null) is never ready — waits out the deadline as timeout", async () => {
		const repo = await base();
		const item = mint(repo);
		const wt = join(repo, ".worktrees", item);
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		expect(
			await awaitLaneExit(repo, `suspenders/${item}`, 60, () => null, 20),
		).toBe("timeout");
		rmSync(repo, { recursive: true, force: true });
	});

	test("awaitLaneExit: unknown→proven-dead flip reads ready (null keeps polling)", async () => {
		const repo = await base();
		const item = mint(repo);
		const wt = join(repo, ".worktrees", item);
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
		let calls = 0;
		expect(
			await awaitLaneExit(
				repo,
				`suspenders/${item}`,
				5_000,
				() => (calls++ < 2 ? null : false),
				20,
			),
		).toBe("ready");
		expect(calls).toBeGreaterThanOrEqual(3);
		rmSync(repo, { recursive: true, force: true });
	});
});
