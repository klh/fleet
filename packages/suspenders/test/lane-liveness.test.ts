// Regression pins for the shared lane-liveness surface (2026-10-05 ghost-pid
// + host-trust leaks): host lanes live ONLY on transcript freshness; local
// lanes need process-identity or a live worktree cwd; dead/absent never lies.
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import {
	transcriptAlive,
	laneAlive,
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
