// Regression pins for the shared lane-liveness surface (2026-10-05 ghost-pid
// + host-trust leaks; W494.1: pid/heartbeat verdict, worktree cwd demoted to
// sweep evidence). Host lanes live ONLY on transcript freshness; local lanes
// need process-identity or a fresh heartbeat inside the 15-min reclaim lease.
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import {
	transcriptAlive,
	laneAlive,
	worktreeLive,
	HARNESS_ARG_RE,
} from "../hooks/lib/lane-liveness.ts";

describe("lane-liveness surface", () => {
	test("host lane: fresh claimant transcript → live; stale → dead", () => {
		const home = `${import.meta.dir}/.tmp-home-${Date.now()}`;
		const proj = `${home}/.claude/projects/-tmp-proj`;
		mkdirSync(proj, { recursive: true });
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			writeFileSync(`${proj}/session-autowx.jsonl`, "{}");
			expect(transcriptAlive("autowx")).toBe(true);
			// age the transcript past the 15-min floor
			utimesSync(`${proj}/session-autowx.jsonl`, new Date(0), new Date(0));
			expect(transcriptAlive("autowx")).toBe(false);
			expect(
				laneAlive({ sid: "autowx", item: "W1", host: "nas.threads.dk" }),
			).toBe(false);
		} finally {
			process.env.HOME = realHome;
			Bun.spawnSync(["/bin/rm", "-rf", home]);
		}
	});

	test("local lane: recycled pid + missing worktree reads dead", () => {
		expect(
			laneAlive({
				sid: "autowz",
				item: "W9",
				pid: 999999999,
				worktree: "/nonexistent-wt",
			}),
		).toBe(false);
		expect(laneAlive({ sid: "autowz", item: "W9" })).toBe(false);
	});

	test("local lane: pid gone, heartbeat fresh inside the lease → live (W494.1)", () => {
		const home = `${import.meta.dir}/.tmp-home-${Date.now()}`;
		const proj = `${home}/.claude/projects/-tmp-proj`;
		mkdirSync(proj, { recursive: true });
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			writeFileSync(`${proj}/session-autowh.jsonl`, "{}");
			// recorded pid is dead; the claimant transcript (heartbeat) is fresh
			// inside the 15-min reclaim lease — the lane reads LIVE
			expect(
				laneAlive({
					sid: "autowh",
					item: "W9",
					pid: 999999999,
					worktree: "/nonexistent-wt",
				}),
			).toBe(true);
		} finally {
			process.env.HOME = realHome;
			Bun.spawnSync(["/bin/rm", "-rf", home]);
		}
	});

	test("worktree cwd never rescues a dead lease (W494.1 demotion)", () => {
		// a REAL harness-args process with cwd in an existing dir proves the
		// evidence probe fires — yet the verdict still reads DEAD: cwd is a
		// location, not a heartbeat.
		const dir = `${import.meta.dir}/.tmp-wt-${Date.now()}`;
		mkdirSync(dir, { recursive: true });
		// HARNESS_ARG_RE needs the harness word at line-start or after a slash:
		// a sleep binary named `claude` gives ps args "…/<dir>/claude 30"
		Bun.spawnSync(["/bin/ln", "-sf", "/bin/sleep", `${dir}/claude`]);
		const proc = Bun.spawn([`${dir}/claude`, "30"], { cwd: dir });
		try {
			// poll: ps/lsof visibility lags the spawn by a few hundred ms
			let evidence = false;
			for (let i = 0; i < 20 && !evidence; i++) {
				evidence = worktreeLive(dir);
				if (!evidence) Bun.spawnSync(["/bin/sleep", "0.1"]);
			}
			expect(evidence).toBe(true);
			expect(
				laneAlive({
					sid: "autowd",
					item: "W9",
					pid: 999999999,
					worktree: dir,
				}),
			).toBe(false);
		} finally {
			proc.kill();
			Bun.spawnSync(["/bin/rm", "-rf", dir]);
		}
	});

	test("worktreeLive prefix discipline (W123): sibling with shared id-prefix reads not-live, subdir still counts", () => {
		// `.worktrees/W12` must not match a lane sitting in `.worktrees/W123`
		// (bare startsWith collided on shared id-prefixes) while a cwd in a
		// SUBDIR of the tree still counts — pin both sides at once by sitting
		// the lane in a subdir.
		const base = `${import.meta.dir}/.tmp-wtcol-${Date.now()}`;
		const short = `${base}/W12`;
		const long = `${base}/W123`;
		mkdirSync(`${long}/sub`, { recursive: true });
		mkdirSync(short, { recursive: true });
		// the binary name is the harness contract: a sleep copy named `claude`
		// gives ps args "…/W123/sub/claude 30"
		Bun.spawnSync(["/bin/ln", "-sf", "/bin/sleep", `${long}/sub/claude`]);
		const proc = Bun.spawn([`${long}/sub/claude`, "30"], {
			cwd: `${long}/sub`,
		});
		try {
			// poll: ps/lsof visibility lags the spawn by a few hundred ms
			let pinned = false;
			for (let i = 0; i < 20 && !pinned; i++) {
				pinned = worktreeLive(long) && !worktreeLive(short);
				if (!pinned) Bun.spawnSync(["/bin/sleep", "0.1"]);
			}
			expect(pinned).toBe(true);
		} finally {
			proc.kill();
			Bun.spawnSync(["/bin/rm", "-rf", base]);
		}
	});

	test("harness anchor (W494): coord-subscribe phantoms read dead, real lanes live", () => {
		// args verbatim from the machine, 2026-10-06 ghost anatomy: 19
		// orphaned `coord.ts subscribe` processes (PPID 1, cwd pinned to the
		// lane worktree) matched the UNANCHORED /claude/i — every dead row
		// read live forever.
		expect(
			HARNESS_ARG_RE.test(
				"bun /Users/kk/.claude/hooks/suspenders/bin/coord.ts subscribe --as autow1",
			),
		).toBe(false);
		expect(
			HARNESS_ARG_RE.test(
				"/Users/kk/.local/bin/claude -p Read /Volumes/x — mission autow1",
			),
		).toBe(true);
		expect(HARNESS_ARG_RE.test("claude -p mission")).toBe(true);
	});

	// W466 bounding: the scan is a depth-capped readdir walk, not an
	// unbounded `**` glob — but the documented layouts must still hit:
	// main (depth 2) and subagents (<proj>/<parent>/subagents/, depth 4).
	test("W466: subagent transcript at depth 4 found; stale memo transitions immediately", () => {
		const home = `${import.meta.dir}/.tmp-home-w466-${Date.now()}`;
		const deep = `${home}/.claude/projects/-tmp-proj/parent-session/subagents`;
		mkdirSync(deep, { recursive: true });
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			writeFileSync(`${deep}/agent-autowsub.jsonl`, "{}");
			expect(transcriptAlive("autowsub")).toBe(true);
			// positive memo re-validates by stat: age the file past the floor
			// and the SAME sid reads dead on the next probe
			utimesSync(`${deep}/agent-autowsub.jsonl`, new Date(0), new Date(0));
			expect(transcriptAlive("autowsub")).toBe(false);
		} finally {
			process.env.HOME = realHome;
			Bun.spawnSync(["/bin/rm", "-rf", home]);
		}
	});
});
