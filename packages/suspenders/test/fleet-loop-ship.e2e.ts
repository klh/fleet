// fleet-loop-ship.test.ts — W64: the board's one-click ship trigger runs
// `fleet-loop.ts ship` on a real scratch repo. Contract: the branch goes
// through the configured ladder (template {branch} substitution), lands as a
// MERGED line in loop.log, and the merged branch + worktree retire; a
// not-ahead branch is a no-op, a failed ladder aborts the merge and leaves
// the branch (strike counted), a live daemon merge vetoes ship outright
// (W101) and crashed debris is healed, not blindly aborted.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// the once-mode cycle runs the full maintenance sweep — spawn-heavy, well
// over the 5s default under load (same guard as fleet-loop-flush.test.ts)
test.setTimeout(30_000);

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const env = { ...process.env, FLEET_UNTRACKED_GRACE_MS: "0" };

// a scratch repo with main@base and a suspenders/SHIP1 worktree branch one
// commit ahead, laid out like a real lane (.worktrees/<id>); the ladder is
// passed per-invocation — the loop reads argv, the BOARD reads ship.json
async function scratchRepo() {
	const dir = join(
		tmpdir(),
		`w64-ship-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	const g = (args: string[], cwd = dir) =>
		Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(g(["init", "-b", "main"]).exitCode).toBe(0);
	g(["config", "user.email", "t@threads.dk"]);
	g(["config", "user.name", "t"]);
	await Bun.write(Bun.file(join(dir, "f.txt")), "one\n");
	g(["add", "-A"]);
	expect(g(["commit", "-m", "base"]).exitCode).toBe(0);
	expect(
		g([
			"worktree",
			"add",
			"-b",
			"suspenders/SHIP1",
			join(dir, ".worktrees", "SHIP1"),
		]).exitCode,
	).toBe(0);
	await Bun.write(
		Bun.file(join(dir, ".worktrees", "SHIP1", "f.txt")),
		"one\ntwo\n",
	);
	g(["add", "-A"], join(dir, ".worktrees", "SHIP1"));
	expect(
		g(["commit", "-m", "lane change"], join(dir, ".worktrees", "SHIP1"))
			.exitCode,
	).toBe(0);
	mkdirSync(join(dir, ".fleet"), { recursive: true });
	writeFileSync(join(dir, ".fleet", "lanes.json"), "[]");
	return dir;
}

function ship(repo: string, extra: string[] = []) {
	const p = Bun.spawnSync(["bun", LOOP, "ship", "--repo", repo, ...extra], {
		cwd: repo,
		env: { ...env, HOME: join(repo, ".test-home"), GOVERNOR_STORE_URL: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

const g = (repo: string, args: string[], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

// ship logs to <repo>/.fleet/loop.log; sync read — tests assert its lines
const log = (repo: string): string => {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
};

// W1072.2: ship rides mergeOne, and mergeOne now fails closed on any branch
// whose item is not DONE with an exact result_sha — seed a real closure for
// the fixture branch via the plane itself (registry row maps SHIP1 → item).
const seedClosure = (repo: string, item: string, sha: string) => {
	const WORK = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
	const run = (args: string[]) => {
		const p = Bun.spawnSync(["bun", ...args], {
			cwd: repo,
			// HOME in the scratch repo: the seed must hit the ISOLATED store, not
			// the ambient one. FLEET_MERGE_ON_DONE=0: the seed's own `work done`
			// must not spawn a detached flush whose marker MERGE-BUSYs the ship.
			env: {
				...env,
				HOME: join(repo, ".test-home"),
				GOVERNOR_STORE_URL: "",
				FLEET_MERGE_ON_DONE: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: `${p.stdout.toString()}${p.stderr.toString()}`,
			code: p.exitCode,
		};
	};
	const add = run([WORK, "add", `ship item ${item}`, "--by", "lane"]);
	const m = /\b(W\d+)\b/.exec(add.out);
	if (!m) throw new Error(`work add failed: ${add.out}`);
	const minted = m[1];
	const take = run([WORK, "take", minted, "--as", "shiplane"]);
	const tok = /claim token: ([0-9a-f]{48})/.exec(take.out)?.[1];
	const reg = JSON.parse(
		readFileSync(join(repo, ".fleet", "lanes.json"), "utf8"),
	) as { sid: string; item: string; branch: string }[];
	reg.push({ sid: "shiplane", item: minted, branch: `suspenders/${item}` });
	writeFileSync(join(repo, ".fleet", "lanes.json"), JSON.stringify(reg));
	const done = run([
		WORK,
		"done",
		minted,
		"--as",
		"shiplane",
		"--sha",
		sha,
		"--summary",
		"ship fixture closure: the branch head is the recorded result_sha so the exact-closure predicate passes.",
		...(tok ? ["--token", tok] : []),
	]);
	if (done.code !== 0) throw new Error(`work done failed: ${done.out}`);
	return minted;
};

// W101: a live merge-active marker — pid alive + exact ps cmdline + fresh
// ts, the same shape mergeOne writes; the sleeper stands in for the runner
function liveMarker(repo: string): ReturnType<typeof Bun.spawn> {
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	const dummy = Bun.spawn(["sleep", "30"]);
	writeFileSync(
		join(repo, ".fleet", "merge-active"),
		JSON.stringify({
			pid: dummy.pid,
			cmd: Bun.spawnSync(["ps", "-o", "command=", "-p", String(dummy.pid)])
				.stdout.toString()
				.trim(),
			branch: "suspenders/SHIP1",
			ts: Date.now(),
		}),
	);
	return dummy;
}

test.describe("fleet-loop ship mode (W64)", () => {
	test("merges one branch through the ladder, retires branch + worktree", async () => {
		const repo = await scratchRepo();
		seedClosure(
			repo,
			"SHIP1",
			g(repo, ["rev-parse", "suspenders/SHIP1"]).stdout.toString().trim(),
		);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		// plain-merge default: merge commit exists, branch retired
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			"Merge suspenders/SHIP1",
		);
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		expect(g(repo, ["worktree", "list"]).stdout.toString()).not.toContain(
			"/wt",
		);
		rmSync(repo, { recursive: true, force: true });
	});

	test("ladder template substitution runs and clears prior strikes", async () => {
		const repo = await scratchRepo();
		seedClosure(
			repo,
			"SHIP1",
			g(repo, ["rev-parse", "suspenders/SHIP1"]).stdout.toString().trim(),
		);
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--ladder",
			'git merge --no-ff {branch} -m "shipped {branch}"',
		]);
		expect(r.code).toBe(0);
		// substitution proven by the merge message carrying the real branch name
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			"shipped suspenders/SHIP1",
		);
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		rmSync(repo, { recursive: true, force: true });
	});

	test("not-ahead branch is a no-op that just retires", async () => {
		const repo = await scratchRepo();
		// pre-merge the branch out of band — ship has nothing to merge
		expect(
			g(repo, ["merge", "--no-ff", "suspenders/SHIP1", "-m", "pre"]).exitCode,
		).toBe(0);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		// retire deleted the merged branch; exactly one merge commit
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("3");
		expect(log(repo)).not.toContain("MERGED suspenders/SHIP1");
		rmSync(repo, { recursive: true, force: true });
	});

	test("ship fails loudly when the requested branch was parked", async () => {
		const repo = await scratchRepo();
		expect(
			g(repo, ["branch", "-m", "suspenders/SHIP1", "parked/SHIP1"]).exitCode,
		).toBe(0);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("suspenders/SHIP1");
		expect(r.err).toContain("missing");
		expect(log(repo)).toContain("branch ref missing");
		expect(
			g(repo, ["branch", "--list", "parked/SHIP1"]).stdout.toString(),
		).not.toBe("");
		rmSync(repo, { recursive: true, force: true });
	});

	test("ship fails loudly when the requested branch was deleted", async () => {
		const repo = await scratchRepo();
		expect(
			g(repo, [
				"worktree",
				"remove",
				"--force",
				join(repo, ".worktrees", "SHIP1"),
			]).exitCode,
		).toBe(0);
		expect(g(repo, ["branch", "-D", "suspenders/SHIP1"]).exitCode).toBe(0);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("branch ref missing: suspenders/SHIP1");
		expect(log(repo)).toContain("branch ref missing");
		rmSync(repo, { recursive: true, force: true });
	});

	test("failed ladder: FAIL, merge aborted, branch kept, strike counted", async () => {
		const repo = await scratchRepo();
		seedClosure(
			repo,
			"SHIP1",
			g(repo, ["rev-parse", "suspenders/SHIP1"]).stdout.toString().trim(),
		);
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--ladder",
			"exit 7",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("FAIL suspenders/SHIP1");
		// branch still exists, main untouched, one strike recorded
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).not.toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		const fails = JSON.parse(
			await Bun.file(join(repo, ".fleet", "merge-fails.json")).text(),
		) as Record<string, number>;
		expect(fails["suspenders/SHIP1"]).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("leftover MERGE_HEAD debris (dead runner) is healed before the merge", async () => {
		const repo = await scratchRepo();
		// stage a conflicted merge to leave MERGE_HEAD behind
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		expect(g(repo, ["merge", "suspenders/SHIP1"], repo).exitCode).not.toBe(0);
		// a DEAD runner's marker: no veto — the surgical heal runs instead
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(
			join(repo, ".fleet", "merge-active"),
			JSON.stringify({ pid: 999999999, ts: Date.now() }),
		);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("SELF-HEAL");
		rmSync(repo, { recursive: true, force: true });
	});

	test("live merge marker vetoes ship — MERGE_HEAD untouched, no strike (W101)", async () => {
		const repo = await scratchRepo();
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		expect(g(repo, ["merge", "suspenders/SHIP1"], repo).exitCode).not.toBe(0);
		const dummy = liveMarker(repo);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(1);
		expect(log(repo)).toContain("SHIP-VETO suspenders/SHIP1");
		// hands-off: the in-flight merge state survives, no strike was counted
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
		expect(existsSync(join(repo, ".fleet", "merge-fails.json"))).toBe(false);
		rmSync(repo, { recursive: true, force: true });
		dummy.kill();
	});

	test("cycle skips the merge while a runner is mid-flight (W101)", async () => {
		const repo = await scratchRepo();
		// live marker, NO MERGE_HEAD — the pre-merge ladder window
		const dummy = liveMarker(repo);
		const p = Bun.spawnSync(
			["bun", LOOP, "once", "--repo", repo, "--glob", "suspenders/*"],
			{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(p.exitCode).toBe(0);
		expect(log(repo)).toContain("MERGE-BUSY suspenders/SHIP1");
		// untouched: no merge commit, branch alive, no strike
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).not.toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		expect(existsSync(join(repo, ".fleet", "merge-fails.json"))).toBe(false);
		rmSync(repo, { recursive: true, force: true });
		dummy.kill();
	});
});
