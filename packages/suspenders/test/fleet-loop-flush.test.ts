// fleet-loop-flush.test.ts — W641: the ladder flush as a control-plane step.
// Contract: flush merges ONLY DONE+verified branches (item DONE in the graph,
// result_sha resolves to the branch head); the govdb lease gates EVERY mode
// (CLAIMED/RUNNING never merges, store-unreadable blocks); an unknown item
// defers; a DONE item whose result_sha ≠ branch head defers; a conflicted
// verified branch is refused by the guard, NEED_DECISION'd, struck — never
// auto-resolved; and watch recovers from the one-arg identity crash that
// left the ladder dead (CONTROLLER-REFUSED, .fleet/loop.log 2026-10-11).
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const WORK = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
const GRACE = { FLEET_UNTRACKED_GRACE_MS: "0" };

const g = (repo: string, args: string[], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

// every subprocess rides a redirected HOME + in-process store: the scratch
// repo's own governor.db, never the fleet's
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

const base = async (): Promise<string> => {
	const dir = join(
		tmpdir(),
		`w641-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// lane-shaped branch for a minted item: worktree + one commit, full head out
const laneBranch = async (repo: string, item: string): Promise<string> => {
	const wt = join(repo, ".worktrees", item);
	expect(
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]).exitCode,
	).toBe(0);
	await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
	g(repo, ["add", "-A"], wt);
	expect(g(repo, ["commit", "-m", `lane change ${item}`], wt).exitCode).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
	return g(repo, ["rev-parse", "HEAD"], wt).stdout.toString().trim();
};

const mint = (repo: string): string => {
	const add = run(repo, [WORK, "add", "flush item", "--by", "lane"]);
	if (add.code !== 0) throw new Error(`work add failed: ${add.out}`);
	const m = /\bW\d+\b/.exec(add.out);
	if (!m) throw new Error(`no item id in: ${add.out}`);
	return m[0];
};

const take = (repo: string, item: string) =>
	run(repo, [WORK, "take", item, "--as", "flushlane"]);

// W1124.16 fixture: a foreign-host lane entry — no process-table trust on
// this host, so its liveness reads true/false ONLY via the claimant
// transcript (which is why it is the honest UNKNOWN shape when absent)
const foreignLane = (repo: string, item: string, sid: string) =>
	writeFileSync(
		join(repo, ".fleet", "lanes.json"),
		JSON.stringify([
			{
				sid,
				item,
				branch: `suspenders/${item}`,
				pid: 999_997,
				worktree: join(repo, ".worktrees", item),
				host: "some-other-host",
				launchedAt: Date.now() - 11 * 60_000,
			},
		]),
	);

// close via the plane itself so result_sha lands exactly as production writes it
const close = (repo: string, item: string, sha: string) => {
	const t = take(repo, item);
	expect(t.code).toBe(0);
	const tok = /claim token: ([0-9a-f]{48})/.exec(t.out)?.[1];
	const done = run(repo, [
		WORK,
		"done",
		item,
		"--as",
		"flushlane",
		"--sha",
		sha,
		"--summary",
		"seed closure paragraph for the flush ladder test: the plane itself records the completion evidence, long enough for the summary validator.",
		...(tok ? ["--token", tok] : []),
	]);
	if (done.code !== 0) throw new Error(`work done failed: ${done.out}`);
};

const flush = (repo: string) =>
	run(repo, [LOOP, "flush", "--repo", repo, "--glob", "suspenders/*"]);

// once — a single full cycle through mergeOne (the ladder the daemon runs)
const once = (repo: string) =>
	run(repo, [LOOP, "once", "--repo", repo, "--glob", "suspenders/*"]);

const touchGitState = (repo: string, name: string) => {
	mkdirSync(join(repo, ".git"), { recursive: true });
	writeFileSync(join(repo, ".git", name), "");
};

// W1302.1: holds carry provenance — owner/reason/expiresAt (A2). writeHold
// lays an arbitrary hold body; touchHold stamps a valid one-hour window.
const writeHold = (repo: string, body: string) => {
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet", "merge-hold"), body);
};

const touchHold = (repo: string) => {
	writeHold(
		repo,
		JSON.stringify({
			owner: "flushlane",
			reason: "operator integration window",
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
		}),
	);
};

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

describe("fleet-loop flush mode (W641)", () => {
	test("merges a DONE+verified branch through the ladder and retires it", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`MERGED suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(true);
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			`Merge suspenders/${item}`,
		);
		rmSync(repo, { recursive: true, force: true });
	});

	test("conflicted verified branch: refused, NEED_DECISION, strike — never auto-resolved", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		// main diverges into a guaranteed conflict with the lane commit
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		const mainCount = g(repo, ["rev-list", "--count", "main"])
			.stdout.toString()
			.trim();
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`FAIL suspenders/${item}`);
		// hands-off: branch + main preserved, one strike, decision requested
		expect(branchGone(repo, item)).toBe(false);
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe(mainCount);
		const fails = JSON.parse(
			await Bun.file(join(repo, ".fleet", "merge-fails.json")).text(),
		);
		expect(fails[`suspenders/${item}`]).toBe(1);
		expect(events(repo, "NEED_DECISION")).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("LEASE-BLOCK: a CLAIMED item's branch never merges (the govdb lease)", async () => {
		const repo = await base();
		const item = mint(repo);
		await laneBranch(repo, item);
		expect(take(repo, item).code).toBe(0);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			`FLUSH-DEFER suspenders/${item} — item ${item} is CLAIMED; the claim owns the branch`,
		);
		expect(branchGone(repo, item)).toBe(false);
		// main untouched, no strike — the block is a defer, not a failure
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		expect(existsSync(join(repo, ".fleet", "merge-fails.json"))).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("LEASE-BLOCK in cycle modes: ship refuses a CLAIMED item's branch", async () => {
		const repo = await base();
		const item = mint(repo);
		await laneBranch(repo, item);
		expect(take(repo, item).code).toBe(0);
		const r = run(repo, [
			LOOP,
			"ship",
			"--repo",
			repo,
			"--branch",
			`suspenders/${item}`,
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`LEASE-BLOCK suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(false);
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		rmSync(repo, { recursive: true, force: true });
	});

	test("defers an item unknown to the graph — fail closed on selection", async () => {
		const repo = await base();
		// a branch-shaped ghost with no work_items row at all
		const wt = join(repo, ".worktrees", "GHOST");
		expect(
			g(repo, ["worktree", "add", "-b", "suspenders/GHOST", wt]).exitCode,
		).toBe(0);
		await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
		g(repo, ["add", "-A"], wt);
		expect(g(repo, ["commit", "-m", "ghost change"], wt).exitCode).toBe(0);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			"FLUSH-DEFER suspenders/GHOST — item GHOST is unknown to the graph",
		);
		expect(
			g(repo, ["branch", "--list", "suspenders/GHOST"]).stdout.toString(),
		).not.toBe("");
		rmSync(repo, { recursive: true, force: true });
	});

	// W1072.2: the exact-closure regression — READY (reclaimed/killed lanes),
	// unknown, stale sha, DONE+exact. Reclaimed W1052.2.2-style partial work
	// must never merge.
	test("READY branch never merges (reclaimed/killed lane) — fail closed", async () => {
		const repo = await base();
		const item = mint(repo);
		await laneBranch(repo, item);
		// take then let the claim die WITHOUT closing: state stays CLAIMED —
		// and the cycle mode (mergeOne) defers too
		expect(take(repo, item).code).toBe(0);
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).not.toContain(`MERGED suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("cycle mergeOne defers a DONE item with a stale result_sha", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		const baseSha = g(repo, ["rev-parse", "main"]).stdout.toString().trim();
		close(repo, item, baseSha); // closure sha ≠ branch head
		expect(head).not.toBe(baseSha);
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			`MERGE-DEFER suspenders/${item} — result_sha ${baseSha} does not resolve to branch HEAD`,
		);
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("cycle mergeOne merges a DONE item whose result_sha IS the branch head", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`MERGED suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(true);
		rmSync(repo, { recursive: true, force: true });
	});

	// W1124.16: the merge gate is tri-state honest — an UNKNOWN liveness probe
	// (foreign-host lane with no transcript: no process-table trust) defers;
	// ONLY a proven-dead lane merges.
	test("cycle mergeOne defers lane liveness UNKNOWN (foreign-host lane, no transcript)", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		foreignLane(repo, item, "w1616lane");
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			`MERGE-DEFER suspenders/${item} — lane liveness unknown`,
		);
		expect(branchGone(repo, item)).toBe(false);
		expect(events(repo, "work.landed")).toBe(0);
		rmSync(repo, { recursive: true, force: true });
	});

	// W1124.16: a LIVE lane still defers (preserved behavior, now through the
	// explicit tri-state) — a fresh claimant transcript is the foreign lane's
	// only liveness term.
	test("cycle mergeOne defers a LIVE lane (foreign-host lane, fresh transcript)", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		const projects = join(repo, ".test-home", ".claude", "projects", "p");
		mkdirSync(projects, { recursive: true });
		await Bun.write(Bun.file(join(projects, "w1616lane.jsonl")), "fake\n");
		foreignLane(repo, item, "w1616lane");
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).not.toContain(`MERGED suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(false);
		expect(events(repo, "work.landed")).toBe(0);
		rmSync(repo, { recursive: true, force: true });
	});

	test("cycle mergeOne defers a branch with no matching work item", async () => {
		const repo = await base();
		const wt = join(repo, ".worktrees", "GHOST");
		expect(
			g(repo, ["worktree", "add", "-b", "suspenders/GHOST", wt]).exitCode,
		).toBe(0);
		await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
		g(repo, ["add", "-A"], wt);
		expect(g(repo, ["commit", "-m", "ghost change"], wt).exitCode).toBe(0);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		const r = once(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			"MERGE-DEFER suspenders/GHOST — item GHOST is unknown to the graph",
		);
		expect(branchGone(repo, "GHOST")).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("defers DONE whose result_sha does not resolve to the branch head", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		const baseSha = g(repo, ["rev-parse", "main"]).stdout.toString().trim();
		close(repo, item, baseSha);
		expect(head).not.toBe(baseSha);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`FLUSH-DEFER suspenders/${item}`);
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	// W1072.2: the operator merge hold — explicit marker, distinct from the
	// dispatch pause; defers merges AND retirement, never strikes/decides.
	test("operator merge-hold defers flush merges and retirement", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		touchHold(repo);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			`FLUSH-DEFER suspenders/${item} — operator merge hold (.fleet/merge-hold)`,
		);
		expect(log(repo)).toContain("FLUSH merged=0 deferred=1");
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("merge-hold defers retirement of an already-merged branch", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		// pre-merge the branch out of band: ahead=0, so the pre-hold code would
		// have retired (deleted branch + worktree) before any hold check
		expect(
			g(repo, ["merge", "--no-ff", `suspenders/${item}`, "-m", "pre"]).exitCode,
		).toBe(0);
		touchHold(repo);
		const r = once(repo);
		expect(r.code).toBe(0);
		// the hold gate sits before the ahead===0 retire — MERGE-DEFER IS the
		// retirement defer here (RETIRE-DEFER is only the mid-merge hold race)
		expect(log(repo)).toContain(
			`MERGE-DEFER suspenders/${item} — operator merge hold (.fleet/merge-hold)`,
		);
		expect(log(repo)).not.toContain("RETIRED suspenders/");
		expect(branchGone(repo, item)).toBe(false);
		// the worktree itself is W827 rogue-reap's concern (it prunes
		// merged-and-clean worktrees independently) — this gate is retirement
		rmSync(repo, { recursive: true, force: true });
	});

	// W1302.1 (A2): the hold is a contract, not a bare marker. An expired
	// hold ages out at the controller: set aside as .expired, NEED_DECISION
	// raised, the sweep is NOT deferred by it — no hold defers merges forever.
	test("expired merge-hold ages out: NEED_DECISION, set aside, sweep not held", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		writeHold(
			repo,
			JSON.stringify({
				owner: "flushlane",
				reason: "quiet window that already ended",
				expiresAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			"HOLD-EXPIRED .fleet/merge-hold — owner=flushlane expired at",
		);
		expect(log(repo)).toContain(
			"set aside as .fleet/merge-hold.expired, merges resume",
		);
		expect(log(repo)).not.toContain("operator merge hold");
		expect(existsSync(join(repo, ".fleet", "merge-hold"))).toBe(false);
		expect(existsSync(join(repo, ".fleet", "merge-hold.expired"))).toBe(true);
		expect(events(repo, "NEED_DECISION")).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	// the A2 shape itself: a bare pre-W1302.1 marker (empty file) is refused —
	// provenance is mandatory, an anonymous hold cannot defer the ladder
	test("bare marker hold (no provenance) refused: NEED_DECISION, sweep not held", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		writeHold(repo, "");
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			"HOLD-REJECTED .fleet/merge-hold — not valid JSON",
		);
		expect(log(repo)).not.toContain("operator merge hold");
		expect(existsSync(join(repo, ".fleet", "merge-hold.rejected"))).toBe(true);
		expect(events(repo, "NEED_DECISION")).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	// the expiry cap: a hold may never defer the ladder for more than 7 days —
	// anything longer is a posture change, not a hold
	test("hold expiring beyond the 7-day cap is refused as malformed", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		writeHold(
			repo,
			JSON.stringify({
				owner: "flushlane",
				reason: "indefinite quiet window",
				expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString(),
			}),
		);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(
			"HOLD-REJECTED .fleet/merge-hold — expiresAt beyond the 7-day hold cap",
		);
		expect(log(repo)).not.toContain("operator merge hold");
		expect(existsSync(join(repo, ".fleet", "merge-hold.rejected"))).toBe(true);
		expect(events(repo, "NEED_DECISION")).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	// W1072.2 (#55099): with a hold up, a detached flush must NEVER abort/reset
	// operator merge state — the heal path stays behind the gate.
	test("flush during cherry-pick + hold: defers, heal never runs, state intact", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		// operator cherry-pick in progress + explicit merge hold
		touchGitState(repo, "CHERRY_PICK_HEAD");
		touchHold(repo);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain(`FLUSH-DEFER suspenders/${item}`);
		expect(log(repo)).not.toContain("SELF-HEAL");
		expect(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
		expect(branchGone(repo, item)).toBe(false);
		rmSync(repo, { recursive: true, force: true });
	});

	test("flush with hold + MERGE_HEAD: heal deferred, MERGE_HEAD preserved", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		// a legitimate (operator) in-flight merge on main
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		expect(g(repo, ["merge", `suspenders/${item}`], repo).exitCode).not.toBe(0);
		touchHold(repo);
		const r = flush(repo);
		expect(r.code).toBe(0);
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
		expect(log(repo)).not.toContain("SELF-HEAL");
		expect(log(repo)).toContain(`FLUSH-DEFER suspenders/${item}`);
		rmSync(repo, { recursive: true, force: true });
	});

	// the pre-fix one-arg identity call died CONTROLLER-REFUSED at every
	// spawn — the ladder daemon never ran a cycle and branches sat unmerged
	test("watch recovers from the one-arg identity crash — ladder runs again", async () => {
		const repo = await base();
		const item = mint(repo);
		const head = await laneBranch(repo, item);
		close(repo, item, head);
		const child = Bun.spawn(
			[
				"bun",
				LOOP,
				"watch",
				"--repo",
				repo,
				"--every",
				"1",
				"--glob",
				"suspenders/*",
			],
			{
				cwd: repo,
				env: testEnv(repo),
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			},
		);
		try {
			await Bun.sleep(4500);
			const text = log(repo);
			expect(text).not.toContain("CONTROLLER-REFUSED");
			expect(text).toContain(`MERGED suspenders/${item}`);
			expect(branchGone(repo, item)).toBe(true);
		} finally {
			child.kill();
			await Bun.sleep(400);
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
