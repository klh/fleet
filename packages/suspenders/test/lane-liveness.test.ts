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
});
