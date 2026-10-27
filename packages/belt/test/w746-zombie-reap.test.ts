// test/w746-zombie-reap.test.ts — W746 zombie reap: an owned child killed
// abruptly (SIGKILL) is detected via its exit promise and reaped INSIDE the
// supervisor interval — the revive loop respawns through the REAL memory
// admission (spawn-admission), whose dead-pid sweep frees the reservation
// the dead child held; the respawn proves the budget freed. Stub children
// on stub ports, a scratch ledger — never live :4000/:890x or the real
// spawn ledger.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitSpawn } from "../bin/spawn-admission.ts";
import { freePort, scratchWorld } from "@klh/test-kit";
import { Supervisor, type Target, tcpProbe } from "../bin/supervisor.ts";

const { home: dir, clean } = scratchWorld({ prefix: "w746-reap-" });
afterAll(() => clean());

const STUB = join(dir, "stub-server.ts");
writeFileSync(
	STUB,
	`Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch: () => new Response("ok") });\n`,
);

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
};

describe("W746 zombie reap through real memory admission", () => {
	test("SIGKILLed spawnReserved-shaped child is reaped + respawned inside the interval", async () => {
		const port = await freePort();
		const ledger = join(dir, "spawn-ledger.json");
		const t: Target = {
			name: "specialist",
			port,
			kind: "specialist",
			owned: true,
			healthPath: "/health",
			bindTimeoutMs: 5_000,
			spawn: () =>
				admitSpawn({
					path: ledger,
					port,
					budgetGb: 31,
					guardGb: 60,
					wiredGb: () => 0,
					alive: pidAlive,
					spawn: () =>
						Bun.spawn([process.execPath, STUB, String(port)], {
							stdin: "ignore",
							stdout: "ignore",
							stderr: "ignore",
						}),
				}),
		};
		const sup = new Supervisor([t], {
			statusFile: join(dir, "status.json"),
			logFile: join(dir, "transitions.log"),
			intervalMs: 30,
			failThreshold: 2,
			hungThreshold: 3,
			backoffBaseMs: 20,
			backoffCapMs: 2_000,
			bindPollMs: 20,
		});
		const done = sup.run();
		// first admit: binds, up, ledger holds its pid
		await waitFor(() => (sup.snapshot().targets[0]?.state ?? "") === "up");
		const firstPid = sup.snapshot().targets[0]?.pid as number;
		let rows = JSON.parse(readFileSync(ledger, "utf8")) as Record<
			string,
			{ pid: number }
		>;
		expect(rows[String(port)]?.pid).toBe(firstPid);
		// the incident: killed abruptly, no cleanup at all
		process.kill(firstPid, "SIGKILL");
		// reaped + respawned inside the interval; admission admitted again —
		// only possible because the dead pid's reservation was swept
		await waitFor(() => {
			const s = sup.snapshot().targets[0];
			return (
				(s?.state ?? "") === "up" &&
				s?.pid !== firstPid &&
				(s?.restarts ?? 0) >= 1
			);
		});
		expect(await tcpProbe(port)).toBe(true);
		rows = JSON.parse(readFileSync(ledger, "utf8")) as Record<
			string,
			{ pid: number }
		>;
		expect(rows[String(port)]?.pid).toBe(
			sup.snapshot().targets[0]?.pid as number,
		);
		expect(rows[String(port)]?.pid).not.toBe(firstPid);
		sup.stop(true);
		await done;
	}, 20_000);
});
