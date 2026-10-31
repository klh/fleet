// rogue-reap-orphan-workers@unit.e2e.ts — W2335: the orphan-worker pass.
// A runner dying mid-suite leaves its Playwright workers reparented to
// launchd (ppid=1); they wedge on the dead runner pipes and balloon
// (2026-10-30: 60-70GB RSS in 36min out of the MAIN checkout's store —
// invisible to the .worktrees-only cwd scan). The pass reaps ppid=1
// WORKER_MARKERS matches that are unsupervised and fleet-scoped (cwd,
// else the store path on the commandline); a lane-owned worktree scope
// is still protected unless its lane reads dead. Injected deps throughout
// — no real ps/lsof/launchctl/kill runs here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	createRogueReap,
	type LaneRef,
	type ReapReport,
	WORKER_MARKERS,
	workerScope,
} from "../hooks/lib/fleet-loop/rogue-reap.ts";

const repo = mkdtempSync(join(tmpdir(), "reap-orphans-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

const ENTRY =
	"node_modules/.bun/playwright@1.64.1/node_modules/playwright/lib/worker/workerProcessEntry.js";
const mainCmd = `bun ${repo}/${ENTRY}`;
const row = (pid: number, ppid: number, cmd: string): string =>
	`  ${pid}     ${ppid} ${cmd}`;

const reap = (opts: {
	ps: string;
	act?: boolean;
	cwdOf?: (pid: number) => string | null;
	lanes?: () => LaneRef[];
	verdictOf?: (l: LaneRef) => "alive" | "dead" | "unknown";
	claimState?: (item: string) => string | null;
	statePath?: string;
	now?: () => number;
	graceMs?: number;
	launchctlList?: () => string;
	log?: (msg: string) => void;
}): { killed: number[]; report: ReapReport } => {
	const killed: number[] = [];
	const report = createRogueReap({
		repo,
		act: opts.act ?? true,
		psOut: () => opts.ps,
		launchctlList: opts.launchctlList ?? (() => ""),
		cwdOf: opts.cwdOf ?? (() => null),
		lanes: opts.lanes ?? (() => []),
		verdictOf: opts.verdictOf ?? (() => "dead"),
		claimState: opts.claimState ?? (() => null),
		git: () => ({ code: 0, out: "" }),
		kill: (pid) => {
			killed.push(pid);
			return true;
		},
		statePath: opts.statePath ?? join(repo, "state.json"),
		now: opts.now,
		graceMs: opts.graceMs,
		log: opts.log ?? (() => {}),
	}).reap();
	return { killed, report };
};

test("WORKER_MARKERS matches the incident commandline shape", () => {
	expect(WORKER_MARKERS.some((m) => mainCmd.includes(m))).toBe(true);
});

test("workerScope: worktree cwd, repo cwd/cmdline, outside repo, other repo", () => {
	const wt = `${repo}/.worktrees/W12`;
	expect(workerScope(`${wt}/packages/x`, mainCmd, repo)).toEqual({
		kind: "worktree",
		path: wt,
	});
	expect(workerScope(repo, mainCmd, repo)).toEqual({
		kind: "repo",
		path: repo,
	});
	expect(workerScope(`${repo}/packages`, mainCmd, repo)).toEqual({
		kind: "repo",
		path: repo,
	});
	// incident shape: lsof cwd failed, the shared store path rides the cmdline
	expect(workerScope(null, mainCmd, repo)).toEqual({
		kind: "repo",
		path: repo,
	});
	expect(workerScope("/elsewhere", mainCmd, repo)).toBeNull();
	expect(workerScope(null, `bun /other/repo/${ENTRY}`, repo)).toBeNull();
});

test("main-checkout orphan (ppid=1, cwd unresolvable) is reaped on orphan evidence", () => {
	const { killed, report } = reap({ ps: row(15754, 1, mainCmd) });
	expect(killed).toEqual([15754]);
	expect(report.candidates[0]?.worktree).toBe(repo);
	expect(report.candidates[0]?.sig).toBe("SIGTERM");
});

test("worker under a live runner (ppid≠1) is spared", () => {
	const { killed, report } = reap({ ps: row(200, 42, mainCmd) });
	expect(killed).toEqual([]);
	expect(report.candidates).toEqual([]);
});

test("worktree orphan: dead lane reaped, alive/unknown lane protected", () => {
	const wtD = `${repo}/.worktrees/W373`;
	const wtA = `${repo}/.worktrees/W9000`;
	const ps = [
		row(300, 1, `bun ${wtD}/${ENTRY}`),
		row(301, 1, `bun ${wtA}/${ENTRY}`),
	].join("\n");
	const { killed } = reap({
		ps,
		cwdOf: (pid) => (pid === 300 ? wtD : wtA),
		lanes: () => [
			{ sid: "dead", item: "W373", worktree: wtD },
			{ sid: "live", item: "W9000", worktree: wtA },
		],
		verdictOf: (l) => (l.sid === "dead" ? "dead" : "alive"),
	});
	expect(killed).toEqual([300]);
});

test("CLAIMED item protects its worktree's orphan worker", () => {
	const wt = `${repo}/.worktrees/W373`;
	const { killed } = reap({
		ps: row(310, 1, `bun ${wt}/${ENTRY}`),
		cwdOf: () => wt,
		claimState: (item) => (item === "W373" ? "CLAIMED" : null),
	});
	expect(killed).toEqual([]);
});

test("worker from another repo is never a candidate", () => {
	const { killed, report } = reap({
		ps: row(400, 1, `bun /other/repo/${ENTRY}`),
		cwdOf: () => "/other/repo",
	});
	expect(killed).toEqual([]);
	expect(report.candidates).toEqual([]);
});

test("launchd-supervised orphan worker is spared", () => {
	const ps = [row(7, 0, "/bin/launchd b"), row(500, 7, mainCmd)].join("\n");
	const { killed } = reap({
		ps,
		launchctlList: () => "7\t0\tcom.suspenders.board",
	});
	expect(killed).toEqual([]);
});

test("orphan worker escalates to SIGKILL past the grace window", () => {
	const statePath = join(repo, "esc.json");
	writeFileSync(statePath, JSON.stringify({ 600: 1_000_000 }));
	const { killed, report } = reap({
		ps: row(600, 1, mainCmd),
		statePath,
		now: () => 1_130_000,
		graceMs: 120_000,
	});
	expect(killed).toEqual([600]);
	expect(report.candidates[0]?.sig).toBe("SIGKILL");
});

test("dry-run reports the orphan, kills nothing", () => {
	const logs: string[] = [];
	const { killed, report } = reap({
		ps: row(700, 1, mainCmd),
		act: false,
		log: (m) => logs.push(m),
	});
	expect(killed).toEqual([]);
	expect(report.dryRun).toBe(true);
	expect(report.candidates.map((c) => c.pid)).toEqual([700]);
	expect(logs.some((l) => l.startsWith("WOULD-REAP"))).toBe(true);
});
