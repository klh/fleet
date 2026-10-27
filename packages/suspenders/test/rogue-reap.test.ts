// test/rogue-reap.test.ts — W827: the rogue-serve reaper. Injected deps
// throughout — no real ps/lsof/launchctl/kill/git runs here.
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRogueReap,
	insideWorktrees,
	parseWorktreeList,
	pruneStaleWorktrees,
	type LaneRef,
	worktreeProtected,
} from "../hooks/lib/fleet-loop/rogue-reap.ts";
import {
	MAINTENANCE_TASKS,
	missingRunners,
	suspendersRoot,
} from "../hooks/lib/fleet-loop/maintenance.ts";

const tmp = mkdtempSync(join(tmpdir(), "reap-"));
const repo = tmp;

const STALE_SERVE =
	"bun /x/fleet/.worktrees/W373/packages/buckle/src/server.ts --port 4102";

const mkDeps = (overrides?: Record<string, unknown>) => ({
	repo,
	act: true,
	psOut: () =>
		[
			`    5     1 ${STALE_SERVE}`,
			"    9     1 bun /x/fleet/.worktrees/W798/fleet-board.ts --port 56552",
			"   10     5 cargo build",
			"   11     1 bun /x/fleet/packages/buckle/src/server.ts",
			"   12     1 zsh",
		].join("\n"),
	cwdOf: (pid: number): string | null =>
		({
			5: `${repo}/.worktrees/W373/packages/buckle`,
			9: `${repo}/.worktrees/W798`,
			10: `${repo}/.worktrees/W373`,
			11: `${repo}/packages/buckle`,
			12: `${repo}`,
		})[pid] ?? null,
	lanes: (): LaneRef[] => [],
	verdictOf: (): "alive" | "dead" | "unknown" => "dead",
	claimState: (): string | null => null,
	git: (): { code: number; out: string } => ({ code: 0, out: "" }),
	kill: (): boolean => true,
	statePath: join(tmp, "state.json"),
	log: (): void => {},
	...overrides,
});

describe("parseWorktreeList (W827)", () => {
	const porcelain = [
		"worktree /repo",
		"HEAD abc",
		"",
		"worktree /repo/.worktrees/W373",
		"HEAD def",
		"branch refs/heads/suspenders/W373",
		"",
		"worktree /repo/.worktrees/W500",
		"HEAD 789",
		"branch refs/heads/suspenders/W500",
		"locked old run",
		"",
		"worktree /repo/.worktrees/W501",
		"branch refs/heads/suspenders/W501",
		"detached",
		"",
	].join("\n");
	test("parses blocks: branch, HEAD, bare/detached/locked flags", () => {
		const rows = parseWorktreeList(porcelain);
		expect(rows).toHaveLength(4);
		expect(rows[1]?.branch).toBe("refs/heads/suspenders/W373");
		expect(rows[1]?.head).toBe("def");
		expect(rows[2]?.locked).toBe(true);
		expect(rows[3]?.detached).toBe(true);
	});
});

describe("insideWorktrees (W827)", () => {
	test("exact, subdir, sibling-prefix, outside, root itself", () => {
		expect(insideWorktrees(`${repo}/.worktrees/W12`, repo)).toBe(
			`${repo}/.worktrees/W12`,
		);
		expect(insideWorktrees(`${repo}/.worktrees/W12/packages/x`, repo)).toBe(
			`${repo}/.worktrees/W12`,
		);
		expect(insideWorktrees(`${repo}/.worktrees/W123`, repo)).not.toBe(
			`${repo}/.worktrees/W12`,
		);
		expect(insideWorktrees(`${repo}/packages`, repo)).toBeNull();
		expect(insideWorktrees(`${repo}/.worktrees`, repo)).toBeNull();
	});
});

describe("worktreeProtected (W827)", () => {
	const wt = "/repo/.worktrees/W373";
	const lane = (worktree: string): LaneRef => ({
		sid: "s1",
		item: "W373",
		worktree,
	});
	test("dead lane does not protect; alive/unknown do", () => {
		expect(
			worktreeProtected(wt, [lane(wt)], () => "dead", undefined),
		).toBeNull();
		expect(
			worktreeProtected(wt, [lane(wt)], () => "alive", undefined),
		).toContain("lane s1");
		expect(
			worktreeProtected(wt, [lane(wt)], () => "unknown", undefined),
		).toContain("lane s1");
	});
	test("CLAIMED/RUNNING item protects", () => {
		expect(
			worktreeProtected(
				wt,
				[],
				() => "dead",
				() => "CLAIMED",
			),
		).toBe("item W373 CLAIMED");
		expect(
			worktreeProtected(
				wt,
				[],
				() => "dead",
				() => "RUNNING",
			),
		).toBe("item W373 RUNNING");
		expect(
			worktreeProtected(
				wt,
				[],
				() => "dead",
				() => null,
			),
		).toBeNull();
	});
	test("sibling worktree lane does NOT protect", () => {
		expect(
			worktreeProtected(wt, [lane(`${wt}-other`)], () => "alive", undefined),
		).toBeNull();
	});
});

describe("createRogueReap (W827)", () => {
	test("stale serve is TERMed, state written", () => {
		const kills: string[] = [];
		const logs: string[] = [];
		const r = createRogueReap(
			mkDeps({
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
				log: (m) => {
					logs.push(m);
				},
			}),
		).reap();
		expect(r.dryRun).toBe(false);
		expect(kills).toEqual(["5:SIGTERM", "9:SIGTERM"]);
		expect(r.candidates.map((c) => c.pid)).toEqual([5, 9]);
	});
	test("escalates to SIGKILL past the grace window", () => {
		const kills: string[] = [];
		const t0 = 1_000_000;
		const statePath = join(tmp, "esc.json");
		writeFileSync(statePath, JSON.stringify({ 5: t0 }));
		const r = createRogueReap(
			mkDeps({
				now: () => t0 + 130_000,
				graceMs: 120_000,
				statePath,
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
			}),
		).reap();
		expect(kills).toEqual(["5:SIGKILL", "9:SIGTERM"]);
		expect(r.candidates[0]?.sig).toBe("SIGKILL");
	});
	test("dry-run kills nothing, writes no state, logs WOULD-REAP", () => {
		const kills: string[] = [];
		const logs: string[] = [];
		const statePath = join(tmp, "dry.json");
		const r = createRogueReap(
			mkDeps({
				act: false,
				statePath,
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
				log: (m) => {
					logs.push(m);
				},
			}),
		).reap();
		expect(r.dryRun).toBe(true);
		expect(kills).toEqual([]);
		expect(r.candidates.map((c) => c.pid)).toEqual([5, 9]);
		expect(logs.some((l) => l.startsWith("WOULD-REAP"))).toBe(true);
	});
	test("live lane protects its worktree's serves", () => {
		const wt = `${repo}/.worktrees/W373`;
		const r = createRogueReap(
			mkDeps({
				lanes: () => [
					{ sid: "sid-a", item: "W373", worktree: wt },
					{ sid: "sid-b", item: "W798", worktree: `${repo}/.worktrees/W798` },
				],
				verdictOf: () => "alive",
				kill: () => {
					throw new Error("must not kill");
				},
			}),
		).reap();
		expect(r.candidates).toEqual([]);
	});
	test("CLAIMED item protects its worktree's serves", () => {
		const kills: string[] = [];
		const r = createRogueReap(
			mkDeps({
				claimState: (item) => (item === "W373" ? "CLAIMED" : null),
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
			}),
		).reap();
		expect(r.candidates.map((c) => c.pid)).toEqual([9]);
		expect(kills).toEqual(["9:SIGTERM"]);
	});
	test("launchd-supervised serves are spared", () => {
		const kills: string[] = [];
		const r = createRogueReap(
			mkDeps({
				psOut: () =>
					[
						"    7     1 /bin/launchd b",
						"    5     7 bun /x/fleet/.worktrees/W373/packages/buckle/src/server.ts",
					].join("\n"),
				launchctlList: () => "7\t0\tcom.suspenders.board",
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
			}),
		).reap();
		expect(kills).toEqual([]);
		expect(r.candidates).toEqual([]);
	});
	test("non-.worktrees cwd and unknown cwd are spared", () => {
		const kills: string[] = [];
		const r = createRogueReap(
			mkDeps({
				cwdOf: (pid) =>
					({
						5: `${repo}/packages/buckle`,
						9: null,
					})[pid] ?? null,
				kill: (pid, sig) => {
					kills.push(`${pid}:${sig}`);
					return true;
				},
			}),
		).reap();
		expect(kills).toEqual([]);
		expect(r.candidates).toEqual([]);
	});
	test("paused via .fleet/rogue-reap-paused", () => {
		mkdirSync(`${repo}/.fleet`, { recursive: true });
		writeFileSync(`${repo}/.fleet/rogue-reap-paused`, "");
		try {
			const r = createRogueReap(mkDeps({})).reap();
			expect(r.paused).toBe(true);
			expect(r.candidates).toEqual([]);
		} finally {
			rmSync(`${repo}/.fleet/rogue-reap-paused`, { force: true });
		}
	});
	test("state drops entries for pids that vanished", () => {
		const statePath = join(tmp, "drop.json");
		writeFileSync(statePath, JSON.stringify({ 5: 1, 999: 1 }));
		createRogueReap(mkDeps({ statePath })).reap();
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		expect(st["5"]).toBeGreaterThan(0);
		expect(st["999"]).toBeUndefined();
	});
});

describe("pruneStaleWorktrees (W827)", () => {
	const wtPath = `${repo}/.worktrees/W501`;
	const porcelain = [
		`worktree ${repo}/.worktrees/W500`,
		"HEAD abc123",
		"branch refs/heads/suspenders/W500",
		"locked",
		"",
		`worktree ${wtPath}`,
		"HEAD def456",
		"branch refs/heads/suspenders/W501",
		"",
	].join("\n");
	const mkGit = (): {
		calls: string[][];
		git: (args: string[]) => { code: number; out: string };
	} => {
		const calls: string[][] = [];
		const git = (args: string[]): { code: number; out: string } => {
			calls.push(args);
			const j = args.join(" ");
			if (j === "worktree list --porcelain") return { code: 0, out: porcelain };
			if (j === "rev-list --count main..suspenders/W501")
				return { code: 0, out: "0" };
			if (j === `-C ${wtPath} status --porcelain`) return { code: 0, out: "" };
			return { code: 0, out: "" };
		};
		return { calls, git };
	};
	test("merged+clean unclaimed worktree: remove, -d, recovery ref", () => {
		const g = mkGit();
		const out = pruneStaleWorktrees({
			repo,
			main: "main",
			act: true,
			git: g.git,
			protectedReason: () => null,
		});
		expect(out).toEqual([
			{
				worktree: wtPath,
				branch: "suspenders/W501",
				action: "removed",
				why: "merged+clean, pruned",
			},
		]);
		const j = g.calls.map((c) => c.join(" ")).join("\n");
		expect(j).toContain("update-ref refs/recover/suspenders-W501-");
		expect(j).toContain(`worktree remove ${wtPath}`);
		expect(j).toContain("branch -d suspenders/W501");
	});
	test("dry-run reports would-remove, mutates nothing", () => {
		const g = mkGit();
		const out = pruneStaleWorktrees({
			repo,
			main: "main",
			act: false,
			git: g.git,
			protectedReason: () => null,
		});
		expect(out).toEqual([
			{
				worktree: wtPath,
				branch: "suspenders/W501",
				action: "would-remove",
				why: "merged+clean, no live claim",
			},
		]);
		const j = g.calls.map((c) => c.join(" ")).join(" \n");
		expect(j).not.toContain("update-ref");
		expect(j).not.toContain("worktree remove");
	});
	test("dirty, protected and unmerged trees never prune", () => {
		const g = mkGit();
		const base = g.git;
		g.git = (args: string[]) => {
			const j0 = args.join(" ");
			if (j0 === `-C ${wtPath} status --porcelain`)
				return { code: 0, out: " M src/x.ts" };
			return base(args);
		};
		const dirty = pruneStaleWorktrees({
			repo,
			main: "main",
			act: true,
			git: g.git,
			protectedReason: () => null,
		});
		expect(dirty).toEqual([
			{
				worktree: wtPath,
				branch: "suspenders/W501",
				action: "skipped",
				why: "dirty or unreadable",
			},
		]);
	});
	test("protected trees skip with the reason", () => {
		const g = mkGit();
		const prot = pruneStaleWorktrees({
			repo,
			main: "main",
			act: true,
			git: g.git,
			protectedReason: () => "lane s1 not dead",
		});
		expect(prot).toEqual([
			{
				worktree: wtPath,
				branch: "suspenders/W501",
				action: "skipped",
				why: "lane s1 not dead",
			},
		]);
	});
});

describe("rogue-reap maintenance registry (W827)", () => {
	test("the rogue-reap task fires the reaper with --act", () => {
		const t = MAINTENANCE_TASKS.find((x) => x.name === "rogue-reap");
		if (!t) throw new Error("rogue-reap task missing from MAINTENANCE_TASKS");
		const argv = t.argv(suspendersRoot(), "/repo");
		expect(argv.join(" ")).toContain("hooks/bin/rogue-reap.ts");
		expect(argv).toContain("--act");
	});
	test("every folded runner still resolves at the package root", () => {
		expect(missingRunners()).toEqual([]);
	});
});

describe("rogue-reap maintenance registry (W827)", () => {
	test("the rogue-reap task fires the reaper with --act", () => {
		const t = MAINTENANCE_TASKS.find((x) => x.name === "rogue-reap");
		if (!t) throw new Error("rogue-reap task missing from MAINTENANCE_TASKS");
		const argv = t.argv(suspendersRoot(), "/repo");
		expect(argv.join(" ")).toContain("hooks/bin/rogue-reap.ts");
		expect(argv).toContain("--act");
	});
	test("every folded runner still resolves at the package root", () => {
		expect(missingRunners()).toEqual([]);
	});
});
