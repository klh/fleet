// test/hub-orphan-gc.e2e.ts — W2321.5: the hub orphan GC. Origin-marker
// listing + parse wire format, the authority-gated classification ladder,
// serve scoping, the act leg (pin/remove/-d/TERM), the re-list verify, the
// scan-only degradation, and the registry + toGcTarget wiring. All legs
// injected — no ssh, no git, no network.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
	classifyWorktree,
	claimTerminal,
	gcHub,
	listScript,
	parseHubGcListing,
	reapScript,
	scopedServes,
	TERMINAL_STATES,
	type HubGcTarget,
	type HubGcWorktree,
} from "../hooks/lib/fleet-loop/hub-orphan-gc.ts";
import {
	ancestryProbe,
	toGcTarget,
	type realGcExec,
} from "../hooks/bin/hub-orphan-gc.ts";
import { MAINTENANCE_TASKS } from "../hooks/lib/fleet-loop/maintenance.ts";

test.describe("@unit", () => {
	const target: HubGcTarget = {
		name: "nas",
		ssh: "kk@nas",
		repoRoot: "/volume1/hub-nas/fleet",
	};
	const wt = (over?: Partial<HubGcWorktree>): HubGcWorktree => ({
		item: "W123",
		worktree: "/volume1/hub-nas/fleet/.worktrees/W123",
		branch: "suspenders/W123",
		clean: true,
		...over,
	});

	test("listScript embeds the repo root and the marker probe", () => {
		const s = listScript(target);
		expect(s).toContain('git -C "/volume1/hub-nas/fleet" worktree list');
		expect(s).toContain(".fleet/lane-context.json");
		expect(s).toContain("===GC-WORKTREES");
		expect(s).toContain("===GC-PS");
	});

	test("parseHubGcListing: GCWT rows, ps rows, section boundaries", () => {
		const out = [
			"===GC-WORKTREES",
			`GCWT\tW123\t/vol/fleet/.worktrees/W123\tsuspenders/W123\tclean`,
			`GCWT\tW456\t/vol/fleet/.worktrees/W456\tsuspenders/W456\tdirty`,
			"===GC-PS",
			"  4102     1 bun /vol/fleet/.worktrees/W123/fleet-board.ts",
			"===GC-END",
			"GCWT\tW999\t/after-end\tx\tdirty", // past the end marker: ignored
		].join("\n");
		const r = parseHubGcListing(out);
		expect(r.worktrees).toHaveLength(2);
		expect(r.worktrees[1]?.clean).toBe(false);
		expect(r.worktrees[1]?.branch).toBe("suspenders/W456");
		expect(r.ps).toEqual([
			{
				pid: 4102,
				ppid: 1,
				cmd: "bun /vol/fleet/.worktrees/W123/fleet-board.ts",
			},
		]);
	});

	test("claimTerminal: only terminal states license; unknown/absent/throw never", () => {
		const face = (s: string | null) => (item: string) =>
			item === "THROW"
				? (() => {
						throw new Error("store down");
					})()
				: s;
		for (const s of TERMINAL_STATES)
			expect(claimTerminal("W1", face(s))).toBe(true);
		expect(claimTerminal("W1", face("CLAIMED"))).toBe(false);
		expect(claimTerminal("W1", face(null))).toBe(false);
		expect(claimTerminal("W1", face("THROW"))).toBe(false);
		expect(claimTerminal("", face("DONE"))).toBe(false);
	});

	test("classifyWorktree ladder: unreachable → protected → dirty → detached → unmerged → reap", () => {
		const o = (over?: Partial<Parameters<typeof classifyWorktree>[1]>) => ({
			terminal: true,
			authorityReachable: true,
			merged: true,
			pushed: true,
			act: true,
			...over,
		});
		expect(
			classifyWorktree(wt(), o({ authorityReachable: false })).action,
		).toBe("authority-unreachable");
		expect(classifyWorktree(wt(), o({ terminal: false })).action).toBe(
			"protected",
		);
		expect(classifyWorktree(wt({ clean: false }), o()).action).toBe("dirty");
		expect(classifyWorktree(wt({ branch: "DETACHED" }), o()).action).toBe(
			"detached",
		);
		expect(
			classifyWorktree(wt(), o({ merged: false, pushed: false })).action,
		).toBe("unmerged");
		expect(classifyWorktree(wt(), o()).action).toBe("reap");
		expect(classifyWorktree(wt(), o({ act: false })).action).toBe("would-reap");
		// pushed-only evidence still reaps (origin holds the tip)
		expect(classifyWorktree(wt(), o({ merged: false })).action).toBe("reap");
	});

	test("scopedServes: marker + worktree scope + terminal claim", () => {
		const ps = parseHubGcListing(
			[
				"===GC-WORKTREES",
				"===GC-PS",
				`  100   1 bun /vol/fleet/.worktrees/W123/packages/buckle/src/server.ts`,
				`  101   1 bun /vol/fleet/.worktrees/W777/fleet-board.ts`,
				`  102   1 bun /vol/fleet/.worktrees/W124/router-shim.ts`,
				`  103   1 vim /vol/fleet/.worktrees/W123/notes.txt`,
				"===GC-END",
			].join("\n"),
		).ps;
		const states: Record<string, string> = {
			W123: "DONE",
			W777: "CLAIMED",
			W124: "FAILED",
		};
		const serves = scopedServes(ps, "/vol/fleet", (i) => states[i] ?? null);
		expect(serves.map((s) => s.pid)).toEqual([100, 102]);
		expect(serves[0]?.item).toBe("W123");
	});

	test("reapScript: recover pin, remove, merged -d, TERM; pid guard", () => {
		const s = reapScript(
			target,
			[
				{ worktree: "/wt/a", branch: "suspenders/W1", merged: true },
				{ worktree: "/wt/b", branch: "suspenders/W2", merged: false },
			],
			[{ pid: 50 }, { pid: 1 }, { pid: 0 }],
			1_000_000,
		);
		expect(s).toContain("update-ref refs/recover/suspenders-W1-1000");
		expect(s).toContain('worktree remove "/wt/a"');
		expect(s).toContain('branch -d "suspenders/W1"');
		expect(s).not.toContain('branch -d "suspenders/W2"');
		expect(s).toContain("kill -TERM 50");
		expect(s).not.toContain("kill -TERM 1");
	});

	test("gcHub dry-run classifies reapable as would-reap and lists serves", () => {
		const listing = [
			"===GC-WORKTREES",
			`GCWT\tW123\t${target.repoRoot}/.worktrees/W123\tsuspenders/W123\tclean`,
			"===GC-PS",
			"===GC-END",
		].join("\n");
		const exec = (_t: HubGcTarget, script: string) =>
			script.includes("===GC-WORKTREES")
				? { code: 0, out: listing }
				: { code: 0, out: "" };
		const r = gcHub(target, {
			act: false,
			exec,
			claimState: () => "DONE",
			ancestry: () => ({ merged: true, pushed: true }),
		});
		expect(r.dryRun).toBe(true);
		expect(r.rows[0]?.action).toBe("would-reap");
		expect(r.authorityReachable).toBe(true);
	});

	test("gcHub act: reaps terminal+merged rows, verifies by re-list", () => {
		let removed = false;
		const full = (gone: boolean) =>
			gone
				? "===GC-WORKTREES\n===GC-PS\n===GC-END"
				: [
						"===GC-WORKTREES",
						`GCWT\tW123\t${target.repoRoot}/.worktrees/W123\tsuspenders/W123\tclean`,
						`GCWT\tW124\t${target.repoRoot}/.worktrees/W124\tsuspenders/W124\tclean`,
						"===GC-PS",
						"===GC-END",
					].join("\n");
		const acts: string[] = [];
		const exec = (_t: HubGcTarget, script: string) => {
			if (script.includes("update-ref")) {
				acts.push(script);
				removed = true;
				return { code: 0, out: "" };
			}
			return { code: 0, out: full(removed) };
		};
		const states: Record<string, string> = { W123: "DONE", W124: "CLAIMED" };
		const r = gcHub(target, {
			act: true,
			exec,
			claimState: (i) => states[i] ?? null,
			ancestry: () => ({ merged: true, pushed: true }),
		});
		expect(r.reaped).toBe(1);
		expect(r.survivors).toBe(0);
		expect(r.rows.find((x) => x.item === "W124")?.action).toBe("protected");
		expect(acts[0]).toContain("worktree remove");
		expect(acts[0]).toContain('branch -d "suspenders/W123"');
	});

	test("gcHub: throwing claimState degrades the whole fire to scan-only", () => {
		const listing = [
			"===GC-WORKTREES",
			`GCWT\tW123\t${target.repoRoot}/.worktrees/W123\tsuspenders/W123\tclean`,
			"===GC-PS",
			"===GC-END",
		].join("\n");
		const acts: string[] = [];
		const exec = (_t: HubGcTarget, script: string) => {
			if (script.includes("update-ref")) acts.push(script);
			return { code: 0, out: listing };
		};
		const r = gcHub(target, {
			act: true,
			exec,
			claimState: () => {
				throw new Error("authority down");
			},
			ancestry: () => ({ merged: true, pushed: true }),
		});
		expect(r.authorityReachable).toBe(false);
		expect(r.rows.every((x) => x.action !== "reap")).toBe(true);
		expect(r.serves).toEqual([]);
		expect(acts).toEqual([]);
	});

	test("gcHub: unreachable hub leg reports scan-only with no rows", () => {
		const r = gcHub(target, {
			act: true,
			exec: () => ({ code: 255, out: "ssh: connect refused" }),
			claimState: () => "DONE",
		});
		expect(r.authorityReachable).toBe(false);
		expect(r.rows).toEqual([]);
	});

	test("gcHub: unmerged+unpushed terminal rows stay as evidence", () => {
		const listing = [
			"===GC-WORKTREES",
			`GCWT\tW130\t${target.repoRoot}/.worktrees/W130\tsuspenders/W130\tclean`,
			"===GC-PS",
			"===GC-END",
		].join("\n");
		const r = gcHub(
			{ name: "nas", repoRoot: target.repoRoot },
			{
				act: true,
				exec: (_t, s) => ({ code: 0, out: s.includes("===GC") ? listing : "" }),
				claimState: () => "DONE",
				ancestry: () => ({ merged: false, pushed: false }),
			},
		);
		expect(r.rows[0]?.action).toBe("unmerged");
		expect(r.reaped).toBe(0);
	});

	test("ancestryProbe: merged via exit 0, pushed via tip equality", () => {
		const legs: string[] = [];
		const exec = (_t: HubGcTarget, script: string) => {
			legs.push(script);
			if (script.includes("merge-base --is-ancestor"))
				return { code: 0, out: "" };
			if (script.includes("rev-parse origin/"))
				return { code: 0, out: "abc123\n" };
			return { code: 0, out: "abc123\n" };
		};
		const probe = ancestryProbe(exec as ReturnType<typeof realGcExec>);
		expect(probe(target, wt())).toEqual({ merged: true, pushed: true });
		expect(legs[0]).toContain("merge-base --is-ancestor");
		expect(probe(target, wt({ branch: "DETACHED" }))).toEqual({
			merged: false,
			pushed: false,
		});
	});

	test("toGcTarget: lane_gc.repo_root gates; ssh + timeout ride", () => {
		expect(toGcTarget("nas", { lane_gc: { repo_root: "/hub/fleet" } })).toEqual(
			{ name: "nas", repoRoot: "/hub/fleet" },
		);
		expect(
			toGcTarget("nas", {
				deploy: { ssh: "kk@nas", connect_timeout: 7 },
				lane_gc: { repo_root: "/hub/fleet" },
			}),
		).toEqual({
			name: "nas",
			ssh: "kk@nas",
			repoRoot: "/hub/fleet",
			connectTimeout: 7,
		});
		expect(toGcTarget("nas", {})).toBeNull();
	});

	test("heartbeat registry carries the task with the --act bin face", () => {
		const t = MAINTENANCE_TASKS.find((x) => x.name === "hub-orphan-gc");
		expect(t).toBeDefined();
		expect(t?.everySeconds).toBe(1800);
		const argv = t?.argv("/root", "/repo") ?? [];
		expect(argv).toEqual([
			join("/root", "hooks/bin/hub-orphan-gc.ts"),
			"--act",
			"--repo",
			"/repo",
		]);
	});
});
