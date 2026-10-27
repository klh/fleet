// test/service-recycle.test.ts — W1073: the install recycles a supervisor's
// abandoned child listener post-bootstrap (kill the pre-install holder, poll
// a bounded window for a FRESH pid — the restarted supervise respawns it
// from the freshly synced runtime home). Scripted-hook units cover the loop
// contract: the fresh pid wins, the old pid never counts as fresh, SIGKILL
// escalates after the grace, the timeout refuses. A live scenario runs the
// REAL lsof/kill hooks against a real listener replaced mid-flight, and the
// manifest/renderer assertions pin belt-swarm's declared childPort :4000 as
// the config-over-code source the install map is built from.
import { expect, test } from "./pw";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { recycleOnBootstrap } from "../scripts/install-launchd.ts";
import { loadManifest } from "../scripts/install-services.ts";
import {
	processRecycleHooks,
	recycleChildListener,
	type RecycleHooks,
} from "../scripts/lib/service-recycle.ts";

// scripted clock: every now() call advances 100ms, sleeps are free
const tickingHooks = (
	probes: number[][],
	signalLog: string[],
): RecycleHooks => {
	let probe = 0;
	let t = 0;
	return {
		listenerPids: () => probes[Math.min(probe++, probes.length - 1)] ?? [],
		signal: (pid, sig) => {
			signalLog.push(`${sig}:${pid}`);
			return true;
		},
		sleep: async () => {},
		now: () => (t += 100),
	};
};

test.describe("recycleChildListener (W1073, scripted hooks)", () => {
	test("a fresh pid wins and the old holders are recorded", async () => {
		const log: string[] = [];
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			tickingHooks([[4100], [4100], [4242]], log),
		);
		expect(res).toEqual({ ok: true, pid: 4242, oldPids: [4100] });
		expect(log).toEqual(["SIGTERM:4100"]);
	});

	test("the old pid is never accepted back — SIGKILL escalates, timeout refuses", async () => {
		const log: string[] = [];
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			tickingHooks([[4100]], log),
		);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.oldPids).toEqual([4100]);
			expect(res.reason).toContain("port 4000");
			expect(res.reason).toContain("no verified fresh listener");
		}
		expect(log).toEqual(["SIGTERM:4100", "SIGKILL:4100"]);
	});

	test("a port with no pre-install holder still waits for a fresh listener", async () => {
		const log: string[] = [];
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			tickingHooks([[], [4242]], log),
		);
		expect(res).toEqual({ ok: true, pid: 4242, oldPids: [] });
		expect(log).toEqual([]);
	});

	test("B3 negative: a fresh pid beside a surviving old holder is refused", async () => {
		const log: string[] = [];
		// 222 appears immediately but 111 never leaves — never a recycle
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			tickingHooks([[111], [111, 222]], log),
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.oldPids).toEqual([111]);
	});

	test("B3: ok only after the last old holder leaves the port", async () => {
		const log: string[] = [];
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			tickingHooks([[111], [111, 222], [222]], log),
		);
		expect(res).toEqual({ ok: true, pid: 222, oldPids: [111] });
	});
});

test.describe("recycle identity proof (W1073 B2, scripted hooks)", () => {
	test("an unverified holder is never signaled and fails the window", async () => {
		const log: string[] = [];
		const hooks = tickingHooks([[555]], log);
		hooks.identity = (pid) => (pid === 555 ? "sshd" : null);
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			hooks,
		);
		expect(res.ok).toBe(false);
		if (!res.ok)
			expect(res.reason).toContain("unverified holders left untouched: 555");
		expect(log).toEqual([]);
	});

	test("a holder proving the expected child class is signaled", async () => {
		const log: string[] = [];
		const hooks = tickingHooks([[111], [4242]], log);
		hooks.identity = (pid) => (pid === 111 ? "/opt/homebrew/bin/bun" : "bun");
		const res = await recycleChildListener(
			{ port: 4000, deadlineMs: 30_000, graceMs: 3_000 },
			hooks,
		);
		expect(res).toEqual({ ok: true, pid: 4242, oldPids: [111] });
		expect(log).toEqual(["SIGTERM:111"]);
	});
});

test.describe("recycle binds to an explicit bootstrap (W1073 B1)", () => {
	test("a declared child recycles only when the unit actually bootstrapped", () => {
		expect(recycleOnBootstrap(4000, true)).toBe(4000);
		expect(recycleOnBootstrap(4000, false)).toBe(null);
		expect(recycleOnBootstrap(undefined, true)).toBe(null);
	});
});

test.describe("belt-swarm childPort declaration (W1073, config-over-code)", () => {
	test("the manifest declares the abandoned :4000 child listener", () => {
		const spec = loadManifest().find((s) => s.name === "belt-swarm");
		expect(spec?.childPort).toBe(4000);
	});

	test("the declared childPort rides the renderer's --json (install map source)", () => {
		// --out keeps unit bodies off stdout — the JSON report is the only output
		const dir = mkdtempSync(join(tmpdir(), "fleet-childport-"));
		try {
			const proc = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "../scripts/install-services.ts"),
					"--target",
					"darwin",
					"--service",
					"belt-swarm",
					"--out",
					join(dir, "units"),
					"--json",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(proc.exitCode).toBe(0);
			const report = JSON.parse(proc.stdout.toString()) as {
				services: { service: string; childPort?: number }[];
			};
			expect(report.services[0]?.service).toBe("belt-swarm");
			expect(report.services[0]?.childPort).toBe(4000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// live scenario: the real lsof/kill hooks recycle a real loopback listener;
// the test plays supervise — spawning the replacement when SIGTERM lands —
// exactly the post-install shape where the restarted supervisor respawns the
// child from fresh source and the poll must find a NEW pid.
test.describe("live recycle (W1073, real lsof/kill)", () => {
	const spawned: ReturnType<typeof Bun.spawn>[] = [];
	test.afterAll(() => {
		for (const proc of spawned) proc.kill();
	});

	const listenerScript = (port: number): string => `
for (;;) {
	try {
		Bun.listen({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } });
		break;
	} catch {
		await Bun.sleep(25);
	}
}
setInterval(() => {}, 1 << 30);
`;

	test("a replaced listener lands a fresh pid within the window", async () => {
		// claim an ephemeral port, then hand it to the child listener
		const probe = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = probe.port;
		probe.stop(true);
		const first = Bun.spawn(["bun", "-e", listenerScript(port)], {
			stdout: "ignore",
			stderr: "ignore",
		});
		spawned.push(first);
		const real = processRecycleHooks();
		let replacement: ReturnType<typeof Bun.spawn> | undefined;
		for (
			let waited = 0;
			real.listenerPids(port).length === 0 && waited < 5_000;
			waited += 100
		)
			await Bun.sleep(100);
		expect(real.listenerPids(port)).toEqual([first.pid]);
		const hooks: RecycleHooks = {
			...real,
			signal: (pid, sig) => {
				const delivered = real.signal(pid, sig);
				if (sig === "SIGTERM" && delivered && replacement === undefined) {
					replacement = Bun.spawn(["bun", "-e", listenerScript(port)], {
						stdout: "ignore",
						stderr: "ignore",
					});
					spawned.push(replacement);
				}
				return delivered;
			},
		};
		const res = await recycleChildListener(
			{ port, deadlineMs: 20_000, graceMs: 500 },
			hooks,
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.oldPids).toEqual([first.pid]);
			expect(res.pid).toBe(replacement?.pid);
			expect(res.pid).not.toBe(first.pid);
		}
	}, 30_000);
});
