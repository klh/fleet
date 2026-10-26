import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSpawn } from "../bin/spawn-admission.ts";
const root = mkdtempSync(join(tmpdir(), "fleet-admission-"));
test.afterAll(() => rmSync(root, { recursive: true, force: true }));

test("parallel processes cannot spend one memory budget twice @unit", async () => {
	const modulePath = join(import.meta.dir, "../bin/spawn-admission.ts");
	const ledger = join(root, "parallel.json");
	const fixture = join(root, "child.ts");
	writeFileSync(
		fixture,
		`import {admitSpawn} from ${JSON.stringify(modulePath)};
try { admitSpawn({path: process.argv[2], port:Number(process.argv[3]),budgetGb:31,guardGb:60,wiredGb:()=>5,alive:()=>true,spawn:()=>({pid:process.pid})}); console.log('ADMITTED'); }
catch { console.log('REFUSED'); }
`,
	);
	const children = [8901, 8903].map((port) =>
		Bun.spawn([process.execPath, fixture, ledger, String(port)], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const outputs = await Promise.all(
		children.map(async (child) => {
			expect(await child.exited).toBe(0);
			return (await new Response(child.stdout).text()).trim();
		}),
	);
	expect(outputs.sort()).toEqual(["ADMITTED", "REFUSED"]);
});

test("live reservation survives readiness/timeout; only dead pids are pruned @unit", () => {
	const path = join(root, "prune.json");
	const spawn = (port: number, alive: (pid: number) => boolean) =>
		admitSpawn({
			path,
			port,
			budgetGb: 31,
			guardGb: 60,
			wiredGb: () => 5,
			alive,
			spawn: () => ({ pid: port }),
		});
	spawn(8901, () => true);
	expect(() => spawn(8903, () => true)).toThrow("memory admission refused");
	expect(() => spawn(8901, () => true)).toThrow("already reserved");
	expect(spawn(8903, () => false).pid).toBe(8903);
});

test("ready model reservations overlap wired usage while loading ones still add @unit", () => {
	const path = join(root, "ready-overlap.json");
	const attempt = (port: number, ready: boolean, wired = 35) =>
		admitSpawn({
			path,
			port,
			budgetGb: 20,
			guardGb: 60,
			wiredGb: () => wired,
			alive: () => true,
			ready: (existingPort, pid) =>
				ready && existingPort === 8901 && pid === 8901,
			spawn: () => ({ pid: port }),
		});
	attempt(8901, false);
	expect(() => attempt(8903, false)).toThrow("memory admission refused");
	expect(attempt(8903, true).pid).toBe(8903);
	expect(() => attempt(8906, true, 50)).toThrow("memory admission refused");
});

test("invalid ledger and unknown wired usage fail closed @unit", () => {
	const path = join(root, "invalid.json");
	const attempt = () =>
		admitSpawn({
			path,
			port: 1,
			budgetGb: 1,
			guardGb: 60,
			wiredGb: () => Infinity,
			alive: () => true,
			spawn: () => ({ pid: 1 }),
		});
	expect(attempt).toThrow("memory admission refused");
	writeFileSync(path, "broken JSON");
	expect(attempt).toThrow();
	for (const invalid of [
		null,
		[],
		{ x: { pid: 1, startedAt: 0, ram_gb: -20 } },
	]) {
		writeFileSync(path, JSON.stringify(invalid));
		expect(attempt).toThrow("invalid spawn ledger");
	}
});

test("persistence failure cancels the newly spawned process @unit", () => {
	const path = join(root, "persist-fail.json");
	mkdirSync(`${path}.${process.pid}.new`);
	let cancelled = false;
	expect(() =>
		admitSpawn({
			path,
			port: 1,
			budgetGb: 1,
			guardGb: 60,
			wiredGb: () => 0,
			alive: () => false,
			spawn: () => ({ pid: 123 }),
			cancel: () => {
				cancelled = true;
			},
		}),
	).toThrow();
	expect(cancelled).toBe(true);
});

test("BELT_WIRED_GUARD_GB clamp: empty/garbage env falls back to 60 @unit", async () => {
	process.env.BELT_WIRED_GUARD_GB = "";
	expect((await import("../bin/spawner.ts")).WIRED_GUARD_GB).toBe(60);
	process.env.BELT_WIRED_GUARD_GB = "garbage";
	const garbage = await import("../bin/spawner.ts?clamp=garbage");
	expect(
		Number.isFinite(garbage.WIRED_GUARD_GB) && garbage.WIRED_GUARD_GB > 0,
	).toBe(true);
	expect(garbage.WIRED_GUARD_GB).toBe(60);
	delete process.env.BELT_WIRED_GUARD_GB;
});
