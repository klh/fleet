// test/rogue-reap-w973.test.ts — W973: the reaper's fleet scope extended
// to fleet-ish tmp dirs and commandline-scope serves, with a bounded kill
// batch and reaped/survivors accounting. Injected deps; no real kills.
import { expect, test } from "./pw";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cmdlineScope,
	createRogueReap,
	DEFAULT_MAX_KILL,
	fleetTmpDir,
	worktreeItem,
} from "../hooks/lib/rogue-reap.ts";

const tmp = mkdtempSync(join(tmpdir(), "reap-w973-"));
const repo = tmp;

test.afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

test.describe("W973 fleetTmpDir/worktreeItem", () => {
	test("fleetTmpDir: fleet-ish segments, subdir, rejects non-fleet", () => {
		expect(fleetTmpDir("/private/tmp/w894-base/sub")).toBe(
			"/private/tmp/w894-base",
		);
		expect(fleetTmpDir("/private/tmp/w894-base")).toBe(
			"/private/tmp/w894-base",
		);
		expect(fleetTmpDir("/tmp/w123")).toBe("/tmp/w123");
		expect(fleetTmpDir("/private/tmp/random")).toBeNull();
		expect(fleetTmpDir("/private/tmp")).toBeNull();
		expect(fleetTmpDir("/private/tmp/w894basex")).toBeNull();
		expect(fleetTmpDir("/usr/local/w123")).toBeNull();
	});
	test("worktreeItem: tmp stem → graph id, .worktrees name verbatim", () => {
		expect(worktreeItem("/private/tmp/w894-base")).toBe("W894");
		expect(worktreeItem("/repo/.worktrees/W373")).toBe("W373");
	});
	test("cmdlineScope: worktree + tmp literals authorize, others null", () => {
		expect(
			cmdlineScope(`bun ${repo}/.worktrees/W950/fleet-board.ts --port 1`, repo),
		).toBe(`${repo}/.worktrees/W950`);
		expect(
			cmdlineScope("bun /private/tmp/w894-base/fleet-board.ts --port 1", repo),
		).toBe("/private/tmp/w894-base");
		expect(cmdlineScope("bun /usr/local/bin/server.ts", repo)).toBeNull();
		expect(cmdlineScope("bun x.ts", repo)).toBeNull();
	});
});

type Deps = Record<string, unknown>;

const base = (): Deps => ({
	repo,
	act: true,
	psOut: () => "",
	cwdOf: () => null,
	lanes: () => [],
	verdictOf: (): "alive" | "dead" | "unknown" => "dead",
	claimState: () => null,
	git: () => ({ code: 0, out: "" }),
	kill: () => true,
	statePath: join(tmp, "state.json"),
	log: () => {},
});

test.describe("W973 reap scope + bounded batch", () => {
	test("tmp-scoped serve reaped via cmdline scope with dangling cwd", () => {
		const kills: string[] = [];
		const r = createRogueReap({
			...base(),
			psOut: () =>
				"   21     1 bun /private/tmp/w894-base/fleet-board.ts --port 56552",
			kill: (pid: number, sig: string): boolean => {
				kills.push(`${pid}:${sig}`);
				return true;
			},
		} as never).reap();
		expect(kills).toEqual(["21:SIGTERM"]);
		expect(r.reaped).toBe(1);
		expect(r.survivors).toBe(0);
	});
	test("cmdline .worktrees scope reaps when cwd is null", () => {
		const kills: string[] = [];
		const r = createRogueReap({
			...base(),
			psOut: () =>
				`   22     1 bun ${repo}/.worktrees/W950/fleet-board.ts --port 56552`,
			kill: (pid: number, sig: string): boolean => {
				kills.push(`${pid}:${sig}`);
				return true;
			},
		} as never).reap();
		expect(kills).toEqual(["22:SIGTERM"]);
		expect(r.candidates[0]?.item).toBe("W950");
	});
	test("CLAIMED tmp stem protects (w894-base → W894)", () => {
		const r = createRogueReap({
			...base(),
			psOut: () =>
				"   23     1 bun /private/tmp/w894-base/fleet-board.ts --port 56552",
			claimState: (item: string): string | null =>
				item === "W894" ? "CLAIMED" : null,
			kill: (): boolean => {
				throw new Error("must not kill");
			},
		} as never).reap();
		expect(r.candidates).toEqual([]);
	});
	test("kill batch capped at maxKill; rest deferred as survivors", () => {
		const kills: string[] = [];
		const rows = [40, 41, 42]
			.map(
				(pid) =>
					`  ${pid}     1 bun /private/tmp/w900/fleet-board.ts --port ${pid}`,
			)
			.join("\n");
		const r = createRogueReap({
			...base(),
			psOut: () => rows,
			maxKill: 1,
			kill: (pid: number, sig: string): boolean => {
				kills.push(`${pid}:${sig}`);
				return true;
			},
		} as never).reap();
		expect(kills).toHaveLength(1);
		expect(r.reaped).toBe(1);
		expect(r.candidates).toHaveLength(3);
		expect(r.survivors).toBe(2);
	});
	test("dry-run reports all candidates, kills nothing", () => {
		const kills: string[] = [];
		const r = createRogueReap({
			...base(),
			act: false,
			psOut: () =>
				"   24     1 bun /private/tmp/w858-base/fleet-board.ts --port 7777",
			kill: (pid: number, sig: string): boolean => {
				kills.push(`${pid}:${sig}`);
				return true;
			},
		} as never).reap();
		expect(kills).toEqual([]);
		expect(r.candidates).toHaveLength(1);
		expect(r.dryRun).toBe(true);
		expect(r.survivors).toBe(1);
	});
	test("DEFAULT_MAX_KILL bounds the batch (const contract)", () => {
		expect(DEFAULT_MAX_KILL).toBeGreaterThanOrEqual(177);
	});
	test("escalation state stays empty for cap-deferred pids", () => {
		const rows = [50, 51]
			.map(
				(pid) =>
					`  ${pid}     1 bun /private/tmp/w901/fleet-board.ts --port ${pid}`,
			)
			.join("\n");
		const statePath = join(tmp, "cap-state.json");
		createRogueReap({
			...base(),
			psOut: () => rows,
			maxKill: 0,
			statePath,
		} as never).reap();
		const st = JSON.parse(readFileSync(statePath, "utf8")) as Record<
			string,
			number
		>;
		expect(Object.keys(st)).toEqual([]);
	});
});
