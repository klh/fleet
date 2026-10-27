// test/maintenance-sweep.test.ts — W779 heartbeat fold: typed-task due
// logic, attempt-stamping, fail-isolation and the registry guard. The spawn
// is injected — no real children run here.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(maintenanceSweep()).toEqual({ ran: [], failed: [], skipped: 0 });
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
			expect(r).toEqual({ ran: [], failed: [], skipped: 1 });
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_MAINTENANCE;
			else process.env.SUSPENDERS_MAINTENANCE = prev;
		}
	});
	test("registry guard: every folded runner resolves at the package root", () => {
		expect(missingRunners()).toEqual([]);
		expect(suspendersRoot()).toContain("suspenders");
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
