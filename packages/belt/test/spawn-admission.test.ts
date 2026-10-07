import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSpawn } from "../bin/spawn-admission.ts";
const root = mkdtempSync(join(tmpdir(), "fleet-admission-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("parallel processes cannot spend one memory budget twice", async () => {
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

test("live reservation survives readiness/timeout; only dead pids are pruned", () => {
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

test("invalid ledger and unknown wired usage fail closed", () => {
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
});

test("persistence failure cancels the newly spawned process", () => {
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
