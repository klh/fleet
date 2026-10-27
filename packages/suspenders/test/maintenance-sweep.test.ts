// test/maintenance-sweep.test.ts — W779 heartbeat fold: typed-task due
// logic, attempt-stamping, fail-isolation and the registry guard. The spawn
// is injected — no real children run here.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createMaintenanceSweep,
	isDue,
	MAINTENANCE_TASKS,
	maintenanceStampsPath,
	missingRunners,
	readStamps,
	suspendersRoot,
} from "../hooks/lib/fleet-loop/maintenance.ts";
import { homedir } from "node:os";
import {
	pauseTask,
	readSweepNotices,
} from "../hooks/lib/fleet-loop/sweep-state.ts";

const tmp = mkdtempSync(join(tmpdir(), "maint-"));
const stampsPath = join(tmp, "stamps.json");

describe("maintenance due logic (W779)", () => {
	test("interval: never-ran is due, inside cadence is not, boundary is", () => {
		const t = {
			name: "t",
			everySeconds: 900,
			timeoutMs: 1000,
			argv: () => ["x"],
		};
		expect(isDue(t, undefined, 1_000_000)).toBe(true);
		expect(isDue(t, 1_000_000 - 899_999, 1_000_000)).toBe(false);
		expect(isDue(t, 1_000_000 - 900_000, 1_000_000)).toBe(true);
	});

	test("interval: no cadence fields is malformed and never fires", () => {
		const t = { name: "t", timeoutMs: 1000, argv: () => ["x"] };
		expect(isDue(t, undefined, 1_000_000)).toBe(false);
	});
});

describe("calendar due logic (W779)", () => {
	// local 10:00 today; nowMid = 10:01, nowEarly = 09:59
	const t = {
		name: "t",
		calendar: { hour: 10, minute: 0 },
		timeoutMs: 1000,
		argv: () => ["x"],
	};
	const day = new Date(2026, 9, 18);
	const fire = new Date(
		day.getFullYear(),
		day.getMonth(),
		day.getDate(),
		10,
		0,
	).getTime();
	const nowEarly = fire - 60_000;
	const nowMid = fire + 60_000;
	test("calendar: due only at/after the local fire instant", () => {
		expect(isDue(t, undefined, nowEarly)).toBe(false);
		expect(isDue(t, undefined, nowMid)).toBe(true);
	});
	test("calendar: catch-up-once — last before today's fire re-fires once", () => {
		const yesterday = fire - 24 * 3600_000;
		expect(isDue(t, yesterday, nowMid)).toBe(true);
		expect(isDue(t, nowMid, nowMid + 120_000)).toBe(false);
	});
});

describe("maintenance sweep (W779)", () => {
	const lines: string[] = [];
	const deps = {
		REPO: tmp,
		log: (msg: string): void => {
			lines.push(msg);
		},
		sh: () => "",
		run: () => 0,
		runCap: () => ({ code: 0, out: "" }),
		lanes: () => [],
		bumpFail: () => 1,
		clearFail: () => {},
		ahead: () => 0,
	};
	const mkTask = (name: string, overrides?: object) => ({
		name,
		everySeconds: 1,
		timeoutMs: 5000,
		argv: () => ["runner"],
		...overrides,
	});
	test("attempt-stamps before the child runs; cmd = bun + runner argv", () => {
		rmSync(stampsPath, { force: true });
		const seen: string[] = [];
		const { maintenanceSweep: sweep } = createMaintenanceSweep(deps, {
			tasks: [mkTask("a")],
			stampsPath,
			spawn: (cmd, opts) => {
				seen.push(`${cmd[0]}|${cmd[1]}|${opts.timeoutMs}`);
				return { code: 0, out: "done" };
			},
		});
		const r = sweep();
		const stamps = readStamps(stampsPath);
		expect(stamps.a).toBeGreaterThan(0);
		expect(seen.join()).toContain("runner");
		expect(r.ran).toEqual(["a"]);
		expect(lines.some((l) => l.includes("MAINT a ok"))).toBe(true);
	});
	test("fail-isolated: spawn throw never takes the sweep down", () => {
		rmSync(stampsPath, { force: true });
		const { maintenanceSweep: sweep } = createMaintenanceSweep(deps, {
			tasks: [mkTask("a"), mkTask("b")],
			stampsPath,
			spawn: (cmd) => {
				if (cmd.includes("runner")) throw new Error("boom");
				return { code: 0, out: "" };
			},
		});
		const r = sweep();
		expect(r.failed).toEqual(["a", "b"]);
		expect(r.ran).toEqual([]);
	});
	test("smoke: factory returns { maintenanceSweep } — destructurable, callable once (W1083)", () => {
		const { maintenanceSweep } = createMaintenanceSweep(deps, {
			tasks: [],
			stampsPath,
			spawn: () => {
				throw new Error("must not spawn");
			},
		});
		expect(typeof maintenanceSweep).toBe("function");
		expect(maintenanceSweep()).toEqual({
			ran: [],
			failed: [],
			skipped: 0,
			notices: [],
		});
	});
	test("SUSPENDERS_MAINTENANCE=0 disables the sweep entirely", () => {
		const prev = process.env.SUSPENDERS_MAINTENANCE;
		process.env.SUSPENDERS_MAINTENANCE = "0";
		try {
			const { maintenanceSweep: sweep } = createMaintenanceSweep(deps, {
				tasks: [mkTask("a")],
				stampsPath,
				spawn: () => {
					throw new Error("must not spawn");
				},
			});
			const r = sweep();
			expect(r).toEqual({ ran: [], failed: [], skipped: 1, notices: [] });
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_MAINTENANCE;
			else process.env.SUSPENDERS_MAINTENANCE = prev;
		}
	});
	test("registry guard: every folded runner resolves at the package root", () => {
		expect(missingRunners()).toEqual([]);
		expect(suspendersRoot()).toContain("suspenders");
	});
	test("registry guard: suspendersRoot() resolves to the live package root (W1776)", () => {
		// W1776: the merge that produced 94b7a050 was flagged as leaving
		// packages/suspenders dangling behind the "../../.." hop in
		// suspendersRoot() — pin that the resolved root exists and is the
		// package (package.json present), so the path can't silently dangle.
		const root = suspendersRoot();
		expect(basename(root)).toBe("suspenders");
		expect(existsSync(join(root, "package.json"))).toBe(true);
	});
	test("signals-scan runner argv resolves at the package root (W1775)", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "signals-scan");
		if (!task)
			throw new Error("signals-scan task missing from MAINTENANCE_TASKS");
		const argv = task.argv(suspendersRoot(), "/fleet");
		expect(argv[0]).toBe(join(suspendersRoot(), "hooks/bin/signals-scan.ts"));
		expect(argv.slice(1)).toEqual(["--repo", "/fleet"]);
		expect(existsSync(argv[0] ?? "")).toBe(true);
	});
	test("quota-sweep runner resolves at the package root (W1769)", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "quota-sweep");
		if (!task) throw new Error("quota-sweep task missing from MAINTENANCE_TASKS");
		const runner = task.argv(suspendersRoot())[0];
		expect(runner).toBe(join(suspendersRoot(), "hooks/bin/quota-sweep.ts"));
		expect(existsSync(runner)).toBe(true);
	});
	test("auto-install heartbeat argv pins --repo to the package root (W1243)", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "auto-install");
		if (!task)
			throw new Error("auto-install task missing from MAINTENANCE_TASKS");
		expect(task.argv("/r", "/fleet")).toEqual([
			join("/r", "scripts/auto-install.ts"),
			"--repo",
			join("/fleet", "packages/suspenders"),
		]);
	});
	test("metrics-alert runner argv resolves at the package root (W1773)", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "metrics-alert");
		if (!task)
			throw new Error("metrics-alert task missing from MAINTENANCE_TASKS");
		expect(task.argv("/r")).toEqual([join("/r", "hooks/bin/metrics-alert.ts")]);
		const resolved = task.argv(suspendersRoot())[0];
		expect(existsSync(resolved)).toBe(true);
	});
	test("registry order: zai-catalog-refresh directly after openrouter-free-refresh (W1029.1 serialization contract)", () => {
		const names = MAINTENANCE_TASKS.map((task) => task.name);
		expect(names.indexOf("zai-catalog-refresh")).toBe(
			names.indexOf("openrouter-free-refresh") + 1,
		);
	});
	test("stamps: corrupt or absent file reads as never-ran", () => {
		writeFileSync(stampsPath, "not-json{");
		expect(readStamps(stampsPath)).toEqual({});
		rmSync(stampsPath, { force: true });
	});
	test("stamps path is runtime (home-dir), never a repo path (W1777)", () => {
		// the bare literal "maintenance-stamps.json" is a filename joined onto
		// ~/.claude-insights at runtime — not a repo-tree path; pin the
		// resolution so dangling-path false positives are discoverable at
		// the source.
		expect(maintenanceStampsPath()).toBe(
			join(homedir(), ".claude-insights", "maintenance-stamps.json"),
		);
		expect(maintenanceStampsPath().startsWith(homedir())).toBe(true);
	});
});

describe("W1201 doctrine: failed-source notice + budget pause", () => {
	const dir = join(tmp, "notices");
	process.env.SUSPENDERS_MAINTENANCE_STATE = dir;
	const lines: string[] = [];
	const deps = {
		REPO: tmp,
		log: (msg: string): void => {
			lines.push(msg);
		},
		sh: () => "",
		run: () => 0,
		runCap: () => ({ code: 0, out: "" }),
		lanes: () => [],
		bumpFail: () => 1,
		clearFail: () => {},
		ahead: () => 0,
	};
	const mkTask = (name: string): object => ({
		name,
		everySeconds: 1,
		timeoutMs: 5000,
		argv: () => [name],
	});
	const two = [mkTask("bad-source"), mkTask("good-source")];

	test("failed source = notice line, other tasks keep running", () => {
		rmSync(dir, { recursive: true, force: true });
		lines.length = 0;
		const { maintenanceSweep: sweep } = createMaintenanceSweep(deps, {
			tasks: two,
			stampsPath,
			spawn: (cmd: string[]) =>
				cmd.some((a) => String(a).includes("bad-source"))
					? { code: 1, out: "exit 1: source down" }
					: { code: 0, out: "done" },
		});
		const r = sweep();
		expect(r.failed).toEqual(["bad-source"]);
		expect(r.ran).toEqual(["good-source"]);
		expect(r.notices).toHaveLength(1);
		expect(r.notices[0]).toContain("bad-source fail(1)");
		expect(lines.join("\n")).toContain("MAINT bad-source fail(1)");
		expect(readSweepNotices(dir).join("\n")).toContain("bad-source fail(1)");
	});

	test("budget pause: named stop-reason parks the task, spawn never fires", () => {
		rmSync(dir, { recursive: true, force: true });
		lines.length = 0;
		expect(pauseTask("parked", "spend-cap: oracle leg over budget", dir)).toBe(
			true,
		);
		let spawned = 0;
		const { maintenanceSweep: sweep } = createMaintenanceSweep(deps, {
			tasks: [mkTask("parked"), mkTask("live")],
			stampsPath,
			spawn: () => {
				spawned++;
				return { code: 0, out: "" };
			},
		});
		const r = sweep();
		expect(spawned).toBe(1);
		expect(r.ran).toEqual(["live"]);
		expect(r.skipped).toBe(1);
		expect(lines.join("\n")).toContain(
			"paused(spend-cap: oracle leg over budget)",
		);
	});
});
