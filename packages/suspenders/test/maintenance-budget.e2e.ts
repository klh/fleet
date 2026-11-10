// W2952 — cycle budget + detached maintenance regression specs. Covers:
// budget math (every=120s bounds the cycle, shares split it), inline
// clamp + slice exhaustion, detached admission singleflight + liveness
// across cycles, and the marker lease lifecycle (running / exited /
// deadline SIGTERM→SIGKILL / unverified identity never killed / marker-
// write failure reaps the child).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	MERGE_SHARE,
	MAINT_SHARE,
	planCycleBudget,
	tracker,
} from "../hooks/lib/fleet-loop/cycle-budget.ts";
import {
	detachedMarkerPath,
	detachedState,
	launchDetached,
} from "../hooks/lib/fleet-loop/maintenance-detached.ts";
import {
	createMaintenanceSweep,
	type MaintenanceTask,
} from "../hooks/lib/fleet-loop/maintenance.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "w2952-"));
const exists = (p: string): boolean => {
	try {
		readFileSync(p);
		return true;
	} catch {
		return false;
	}
};
const logs: string[] = [] as string[];
let clock = 0;
const now = () => clock;
const mkSweep = (
	tasks: MaintenanceTask[],
	stampsPath: string,
	spawn: (
		cmd: string[],
		opts: { cwd?: string; timeoutMs: number },
	) => { code: number; out: string },
) =>
	createMaintenanceSweep(
		{ log: (l: string) => logs.lines.push(l) },
		{
			tasks,
			stampsPath,
			spawn,
			now: () => now(),
		},
	);

test.afterEach(() => {
	// SUSPENDERS_MAINT_DETACH_DIR is re-pointed per test and restored by the
	// worker teardown — never leak into sibling specs in the same process
	delete process.env.SUSPENDERS_MAINT_DETACH_DIR;
	delete process.env.SUSPENDERS_MAINT_DETACH;
});

test("budget math: every tick bounds the cycle; shares split it", () => {
	const b = planCycleBudget({ everyMs: 120_000, watchdogMs: 900_000 });
	expect(b.totalMs).toBe(120_000);
	expect(b.mergeMs).toBe(Math.floor(120_000 * MERGE_SHARE));
	expect(b.maintenanceMs).toBe(Math.floor(120_000 * MAINT_SHARE));
	// a small watchdog bounds below every
	const s = planCycleBudget({ everyMs: 120_000, watchdogMs: 60_000 });
	expect(s.totalMs).toBe(60_000 - 15_000);
	// tracker clamps at zero and never goes negative
	const t = tracker(100);
	t.charge(500);
	expect(t.remainingMs()).toBe(0);
});

test("inline tasks clamp to the slice and one bounded notice defers the rest", () => {
	const dir = tmp();
	process.env.SUSPENDERS_MAINT_DETACH_DIR = dir;
	process.env.SUSPENDERS_MAINT_DETACH = "0"; // inline-only: prove clamp+exhaust
	logs.lines = [];
	clock = 0;
	const { maintenanceSweep } = mkSweep(
		[
			{ name: "quick", everySeconds: 60, timeoutMs: 60_000, argv: () => ["x"] },
			{
				name: "heavy",
				everySeconds: 60,
				timeoutMs: 600_000,
				argv: () => ["x"],
			},
		],
		join(dir, "stamps.json"),
		(_cmd: string[], o: { timeoutMs: number }) => {
			clock += 35_000;
			return { code: 0, out: `t=${o.timeoutMs}` };
		},
	);
	const r = maintenanceSweep({ maintenanceMs: 30_000 });
	// quick ran inline (clamped 60s→30s slice remaining), heavy deferred once
	const heavy = logs.lines.find((l) => l.includes("slice exhausted"));
	expect(heavy).toBeTruthy();
	expect(heavy).toContain("1 later tasks");
	expect(r.skipped).toBe(1);
	expect(r.ran).toEqual(["quick"]);
	rmSync(dir, { recursive: true, force: true });
});

test("oversized tasks launch detached and stay singleflight across cycles", async () => {
	const dir = tmp();
	process.env.SUSPENDERS_MAINT_DETACH_DIR = dir;
	logs.lines = [];
	clock = 0;
	const { maintenanceSweep } = mkSweep(
		[
			{
				name: "agent",
				everySeconds: 60,
				timeoutMs: 600_000,
				argv: () => ["/bin/sleep", "1.5"],
			},
		],
		join(dir, "stamps.json"),
		() => ({ code: 0, out: "" }),
	);
	const r1 = maintenanceSweep({ maintenanceMs: 30_000 });
	expect(r1.detached).toEqual(["agent"]);
	expect(r1.skipped).toBe(0);
	expect(exists(detachedMarkerPath("agent"))).toBe(true);
	// cycle 2 while the child sleeps: singleflight skip, no duplicate
	clock += 61_000;
	const r2 = maintenanceSweep({ maintenanceMs: 30_000 });
	expect(r2.detached).toEqual([]);
	expect(r2.skipped).toBe(1);
	// cycle 3 after the child exited: marker cleared by detachedState, task
	// is due again → relaunched (liveness: the task keeps running forever)
	await new Promise((r) => setTimeout(r, 1800));
	clock += 61_000;
	const r3 = maintenanceSweep({ maintenanceMs: 30_000 });
	expect(r3.detached).toEqual(["agent"]);
	expect(exists(detachedMarkerPath("agent"))).toBe(true);
	rmSync(dir, { recursive: true, force: true });
});

test("marker lease: deadline SIGTERM then SIGKILL; receipt banked", async () => {
	const dir = tmp();
	process.env.SUSPENDERS_MAINT_DETACH_DIR = dir;
	// a real child that ignores nothing — default TERM kills it
	const child = Bun.spawn(["/bin/sleep", "30"]);
	await new Promise((r) => setTimeout(r, 150)); // let ps see the pid
	const lstart = "";
	const launched = launchDetached("lease", {
		cmd: ["/bin/sleep", "30"],
		timeoutMs: 1000,
	});
	expect(launched.outcome).toBe("launched");
	void child;
	void lstart;
	const st1 = detachedState("lease", Date.now());
	expect(st1.outcome).toBe("running");
	// past deadline, verified identity: SIGTERM stamped
	const st2 = detachedState("lease", Date.now() + 2000);
	expect(st2.outcome).toBe("timeout");
	// past SIGKILL grace: killed, marker cleared, receipt banked
	const st3 = detachedState("lease", Date.now() + 9000);
	expect(st3.outcome).toBe("killed");
	expect(exists(detachedMarkerPath("lease"))).toBe(false);
	const receipt = readFileSync(
		join(dir, "maintenance-detached-receipts.ndjson"),
		"utf8",
	);
	expect(receipt).toContain('"killed"');
	rmSync(dir, { recursive: true, force: true });
});

test("unverified identity is never killed; stale marker is cleaned", () => {
	const dir = tmp();
	process.env.SUSPENDERS_MAINT_DETACH_DIR = dir;
	// blank-lstart marker over a live pid (pid 1) — unverifiable, must be
	// treated stale WITHOUT signalling
	writeFileSync(
		detachedMarkerPath("ghost"),
		`${JSON.stringify({ task: "ghost", pid: 1, lstart: "", startedAt: 1, deadlineMs: 2, argv0: "x" })}\n`,
	);
	const st = detachedState("ghost", Date.now());
	expect(st.outcome).toBe("exited");
	expect(exists(detachedMarkerPath("ghost"))).toBe(false);
	// pid-reuse: live pid, wrong lstart — marker cleared, no signal
	writeFileSync(
		detachedMarkerPath("reuse"),
		`${JSON.stringify({ task: "reuse", pid: 1, lstart: "Wed Jan 1 00:00:00 2026", startedAt: 1, deadlineMs: 2, argv0: "x" })}\n`,
	);
	const st2 = detachedState("reuse", Date.now());
	expect(["exited", "stale"]).toContain(st2.outcome);
	expect(exists(detachedMarkerPath("reuse"))).toBe(false);
	rmSync(dir, { recursive: true, force: true });
});

test("marker-write failure reaps the just-spawned child (launch stays atomic)", async () => {
	const dir = tmp();
	process.env.SUSPENDERS_MAINT_DETACH_DIR = dir;
	let child: Bun.Subprocess | null = null;
	const r = launchDetached("atomic", {
		cmd: ["/bin/sleep", "30"],
		timeoutMs: 1000,
		spawn: (_cmd, _o) => {
			child = Bun.spawn(["/bin/sleep", "30"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			return child;
		},
		writeMarkerFn: () => {
			throw new Error("disk full");
		},
	});
	if (child === null) throw new Error("spawn stub never ran");
	expect(r.outcome).toBe("launch-failed");
	// the spawned child must be gone — an untracked child may not survive
	const reaped = await Promise.race([
		child.exited,
		new Promise((r) => setTimeout(() => r("timeout"), 2000)),
	]);
	expect(reaped).not.toBe("timeout");
	rmSync(dir, { recursive: true, force: true });
});
