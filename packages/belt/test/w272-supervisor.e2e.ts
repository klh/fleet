// W272 — self-heal: supervisor death detection, backoff, circuit breaker,
// probe-after-respawn, orphan adoption, report-only externals, liveness
// report. Stub children + stub ports only — never touches live :4000/:890x.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livenessReport, renderLiveness } from "../bin/liveness.ts";
import {
	backoffMs,
	type Child,
	isAlert,
	jitteredBackoffMs,
	type ProbeResult,
	RestartBreaker,
	type StatusDoc,
	Supervisor,
	type Target,
	tcpProbe,
} from "../bin/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "w272-"));
const STUB = join(dir, "stub-server.ts");
writeFileSync(
	STUB,
	`Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch: () => new Response("ok") });\n`,
);
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const files = () => {
	seq++;
	return {
		statusFile: join(dir, `status-${seq}.json`),
		logFile: join(dir, `transitions-${seq}.log`),
	};
};

const freePort = (): number => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
};

const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
};

const stateOf = (sup: Supervisor, port: number) =>
	sup.snapshot().targets.find((t) => t.port === port);

/** A fake child that exits as soon as it is spawned (crash loop). */
const crashingChild = (): Child => ({
	pid: 999_999,
	exited: Promise.resolve(1),
	kill: () => {},
});

const fast = {
	random: () => 1,
	intervalMs: 30,
	failThreshold: 2,
	hungThreshold: 3,
	backoffBaseMs: 20,
	backoffCapMs: 2000,
	stableMs: 60_000,
	bindPollMs: 20,
};

const running: Supervisor[] = [];
test.afterEach(() => {
	for (const s of running.splice(0)) s.stop(true);
});
const start = (sup: Supervisor): Promise<void> => {
	running.push(sup);
	return sup.run();
};

test.describe("policy", () => {
	test("equal jitter remains between half-delay and the capped delay @unit", () => {
		expect(jitteredBackoffMs(0, 100, 1000, 0)).toBe(50);
		expect(jitteredBackoffMs(0, 100, 1000, 0.5)).toBe(75);
		expect(jitteredBackoffMs(20, 100, 1000, 1)).toBe(1000);
		expect(jitteredBackoffMs(20, 100, 1000, -3)).toBe(500);
		expect(jitteredBackoffMs(20, 100, 1000, 3)).toBe(1000);
	});
	test("backoff doubles from 0.5s and caps at 30s @unit", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffMs(a))).toEqual([
			500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
		]);
		expect(backoffMs(50)).toBe(30_000);
	});

	test("breaker opens after N restarts per window and closes as it ages @unit", () => {
		const b = new RestartBreaker(3, 1000);
		for (const t of [0, 10, 20]) {
			expect(b.allow(t)).toBe(true);
			b.record(t);
		}
		expect(b.allow(30)).toBe(false);
		expect(b.count(30)).toBe(3);
		expect(b.allow(1005)).toBe(true); // first stamp aged out
	});

	test("alerts: owned down/unhealthy, external down, on-demand idle never @unit", () => {
		expect(isAlert("router", true, "down")).toBe(true);
		expect(isAlert("router", true, "unhealthy")).toBe(true);
		expect(isAlert("router", true, "up")).toBe(false);
		expect(isAlert("external", false, "down")).toBe(true);
		expect(isAlert("ondemand", false, "idle")).toBe(false);
	});
});

test.describe("supervisor — real stub children on stub ports", () => {
	test("orphan adopted, then its death is detected and the shim respawned + bound @unit", async () => {
		const port = freePort();
		// pre-existing server NOT spawned by the supervisor (the PPID-1 orphan)
		const orphan = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: () => new Response("orphan"),
		});
		let spawns = 0;
		const t: Target = {
			name: "router-shim",
			port,
			kind: "router",
			owned: true,
			healthPath: "/health/liveliness",
			bindTimeoutMs: 5000,
			spawn: () => {
				spawns++;
				return Bun.spawn([process.execPath, STUB, String(port)], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
			},
		};
		const f = files();
		const sup = new Supervisor([t], { ...f, ...fast });
		const done = start(sup);

		await waitFor(() => stateOf(sup, port)?.state === "up");
		expect(spawns).toBe(0); // adopted, not double-spawned

		orphan.stop(true); // the incident: shim killed, :4000 dark
		await waitFor(() => spawns === 1 && stateOf(sup, port)?.state === "up");
		expect(await tcpProbe(port)).toBe(true);
		const firstPid = stateOf(sup, port)?.pid as number;
		expect(firstPid).toBeGreaterThan(0);

		// now kill OUR child — death via child exit, respawned again
		process.kill(firstPid, "SIGKILL");
		await waitFor(
			() =>
				spawns === 2 &&
				stateOf(sup, port)?.state === "up" &&
				stateOf(sup, port)?.pid !== firstPid,
		);
		expect(await tcpProbe(port)).toBe(true);
		expect(stateOf(sup, port)?.restarts).toBe(2);

		const log = readFileSync(f.logFile, "utf8");
		expect(log).toContain("up→down");
		expect(log).toContain("backoff→starting");
		expect(log).toContain("starting→up");
		expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(6);

		const doc = JSON.parse(readFileSync(f.statusFile, "utf8")) as StatusDoc;
		expect(doc.supervisorPid).toBe(process.pid);
		expect(doc.targets[0]?.port).toBe(port);
		expect(doc.targets[0]?.lastProbe).not.toBeNull();

		sup.stop(true);
		await done;
	}, 20_000);

	test("healthy router with an old code revision is replaced without touching a model @unit", async () => {
		let desired = "revision-a";
		let served: string | null = "revision-a";
		let routerSpawns = 0;
		const killed: number[] = [];
		const router: Target = {
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			enforceRevision: true,
			generation: () => desired,
			portReleaseMs: 500,
			spawn: () => {
				routerSpawns++;
				served = desired;
				return { pid: 1111, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		const specialist: Target = {
			name: "extract",
			port: 8902,
			kind: "specialist",
			owned: true,
			spawn: () => {
				throw new Error("healthy specialist must not restart");
			},
		};
		const sup = new Supervisor([router, specialist], {
			...files(),
			...fast,
			probe: async (t) =>
				t.port === 4000
					? { tcp: served !== null, http: served !== null, revision: served }
					: { tcp: true, http: true },
			killPort: (port) => {
				killed.push(port);
				if (port === 4000) served = null;
			},
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 4000)?.state === "up");
		expect(routerSpawns).toBe(0);
		desired = "revision-b";
		await waitFor(() => routerSpawns === 1 && served === "revision-b");
		expect(killed).toEqual([4000]);
		expect(stateOf(sup, 8902)?.state).toBe("up");
		await Bun.sleep(100);
		expect(routerSpawns).toBe(1);
		sup.stop();
		await done;
	});

	test("respawn waits for the port to release before spawning the child @unit", async () => {
		let served: string | null = "revision-a";
		const desired = "revision-b";
		let spawns = 0;
		let probesSinceKill = 0;
		let lingerProbes = 0; // dying holder still answers this many probes
		let probesAtSpawn = -1;
		const target: Target = {
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			enforceRevision: true,
			portReleaseMs: 500,
			generation: () => desired,
			spawn: () => {
				spawns++;
				probesAtSpawn = probesSinceKill;
				served = desired;
				return { pid: 1111, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		const sup = new Supervisor([target], {
			...files(),
			...fast,
			probe: async () => {
				if (lingerProbes > 0) {
					lingerProbes--; // the dying holder answers this many more probes
					return { tcp: true, http: true, revision: "revision-a" };
				}
				if (probesSinceKill > 0) probesSinceKill++; // count post-kill probes
				return {
					tcp: served !== null,
					http: served !== null,
					revision: served,
				};
			},
			killPort: () => {
				served = null; // holder gone; linger answers one probe before release
				probesSinceKill = 1;
				lingerProbes = 1;
			},
		});
		const done = start(sup);
		// adopted healthy router (never spawned here); replacement = first spawn
		await waitFor(() => spawns === 1 && served === "revision-b");
		expect(probesAtSpawn).toBeGreaterThan(1); // spawn came after the release wait
		sup.stop();
		await done;
	});

	test("a port that never releases defers the respawn without a breaker record @unit", async () => {
		let served: string | null = "revision-a";
		let spawns = 0;
		const target: Target = {
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			enforceRevision: true,
			portReleaseMs: 120,
			generation: () => "revision-b",
			spawn: () => {
				spawns++;
				served = "revision-b";
				return { pid: 1111, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		const sup = new Supervisor([target], {
			...files(),
			...fast,
			probe: async () => ({
				tcp: served !== null, // holder never dies: TCP always bound
				http: served !== null,
				revision: "revision-a",
			}),
			killPort: () => {}, // SIGKILL misses (zombie holder): port stays held
		});
		const done = start(sup);
		await Bun.sleep(300); // several probe cycles against the held port
		expect(spawns).toBe(0); // never spawned into the held port
		expect(stateOf(sup, 4000)?.restarts).toBe(0); // no breaker record consumed
		sup.stop();
		await done;
	});

	test("stop() during the port-release wait spawns nothing @unit", async () => {
		let spawns = 0;
		const target: Target = {
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			enforceRevision: true,
			portReleaseMs: 60_000,
			generation: () => "revision-b",
			spawn: () => {
				spawns++;
				return { pid: 1111, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		const sup = new Supervisor([target], {
			...files(),
			...fast,
			probe: async () => ({ tcp: true, http: true, revision: "revision-a" }),
			killPort: () => {},
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 4000)?.state === "backoff");
		await Bun.sleep(60); // backoff delay elapsed → inside the release wait
		sup.stop(); // mid-wait
		await done;
		await Bun.sleep(100);
		expect(spawns).toBe(0); // stopped supervisor spawns nothing
	});

	test("stop() during the final port-free probe records and spawns nothing @unit", async () => {
		const s = stopProbeFixture();
		const sup = s.sup;
		const done = start(sup);
		await waitFor(() => s.killed);
		sup.stop();
		s.releaseGate();
		await done;
		expect(s.spawns).toBe(0);
		expect(stateOf(sup, 4000)?.restarts).toBe(0);
	});

	function stopProbeFixture() {
		const f = {
			sup: null as unknown as Supervisor,
			spawns: 0,
			killed: false,
			releaseGate: () => {},
		};
		const gate = new Promise<void>((r) => {
			f.releaseGate = r;
		});
		const target: Target = {
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			enforceRevision: true,
			portReleaseMs: 0,
			generation: () => "revision-b",
			spawn: () => {
				f.spawns++;
				return { pid: 1111, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		f.sup = new Supervisor([target], {
			...files(),
			...fast,
			probe: async () => {
				if (f.killed) {
					await gate; // stop() lands while this post-deadline probe awaits
					return { tcp: false, http: false }; // port released in the gap
				}
				return { tcp: true, http: true, revision: "revision-a" };
			},
			killPort: () => {
				f.killed = true;
			},
		});
		return f;
	}
	test("probe-after-respawn: a live pid that never binds is NOT up @unit", async () => {
		const port = freePort();
		const kills: number[] = [];
		const t: Target = {
			name: "spec",
			port,
			kind: "specialist",
			owned: true,
			bindTimeoutMs: 200,
			spawn: () => {
				// real process that stays alive but never listens
				const c = Bun.spawn(
					[process.execPath, "-e", "setInterval(() => {}, 1000)"],
					{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
				);
				return {
					pid: c.pid,
					exited: c.exited,
					kill: (sig) => {
						kills.push(c.pid);
						c.kill(sig);
					},
				};
			},
		};
		const sup = new Supervisor([t], { ...files(), ...fast });
		const done = start(sup);
		await waitFor(() => kills.length >= 1);
		const s = stateOf(sup, port);
		expect(s?.state).not.toBe("up");
		expect(sup.snapshot().targets[0]?.lastError ?? "").toMatch(
			/no bind|not running|exited/,
		);
		sup.stop(true);
		await done;
	}, 10_000);
});

test.describe("supervisor — stub probes + fake children", () => {
	const down = async (): Promise<ProbeResult> => ({ tcp: false, http: false });

	test("restart budget survives supervisor recreation and expires while probes continue @unit", async () => {
		const f = files();
		let now = 1000;
		let spawns = 0;
		let probes = 0;
		const target: Target = {
			name: "durable",
			port: 91,
			kind: "router",
			owned: true,
			spawn: () => {
				spawns++;
				return crashingChild();
			},
		};
		const opts = {
			...f,
			...fast,
			now: () => now,
			maxRestarts: 2,
			windowMs: 1000,
			backoffBaseMs: 1,
			probe: async () => {
				probes++;
				return down();
			},
		};
		const first = new Supervisor([target], opts);
		const firstDone = start(first);
		await waitFor(() => stateOf(first, 91)?.state === "unhealthy");
		first.stop();
		await firstDone;
		const second = new Supervisor([target], opts);
		const secondDone = start(second);
		await waitFor(() => stateOf(second, 91)?.state === "unhealthy");
		const before = probes;
		await Bun.sleep(90);
		expect(probes).toBeGreaterThan(before);
		expect(spawns).toBe(2);
		expect(stateOf(second, 91)?.restartsLastWindow).toBe(2);
		now = 2001;
		await waitFor(() => spawns > 2);
		second.stop();
		await secondDone;
	});

	test("config generations have independent durable budgets and returning to one preserves its limit @unit", async () => {
		const f = files();
		let generation = "a";
		let spawns = 0;
		const t: Target = {
			name: "revision",
			port: 92,
			kind: "router",
			owned: true,
			generation: () => generation,
			spawn: () => {
				spawns++;
				return crashingChild();
			},
		};
		const sup = new Supervisor([t], {
			...f,
			...fast,
			probe: down,
			maxRestarts: 1,
			backoffBaseMs: 1,
		});
		const done = start(sup);
		await waitFor(
			() => spawns === 1 && stateOf(sup, 92)?.state === "unhealthy",
		);
		generation = "b";
		await waitFor(
			() => spawns === 2 && stateOf(sup, 92)?.state === "unhealthy",
		);
		generation = "a";
		await Bun.sleep(100);
		expect(spawns).toBe(2);
		sup.stop();
		await done;
		const restored = new Supervisor([t], {
			...f,
			...fast,
			probe: down,
			maxRestarts: 1,
		});
		expect(stateOf(restored, 92)?.restartsLastWindow).toBe(1);
	});

	test("failed preflight suspends spawn and port killing, recovers automatically without spending budget @unit", async () => {
		let err: string | null = "dependency missing";
		let spawns = 0;
		let probes = 0;
		let kills = 0;
		let held = true; // hung holder keeps :93 bound until killPort releases it
		const t: Target = {
			name: "dependency",
			port: 93,
			kind: "router",
			owned: true,
			killHung: true,
			preflight: () => err,
			spawn: () => {
				spawns++;
				held = true;
				return crashingChild();
			},
		};
		const sup = new Supervisor([t], {
			...files(),
			...fast,
			backoffBaseMs: 1,
			maxRestarts: 1,
			killPort: () => {
				kills++;
				held = false; // port release, as the kernel does
			},
			probe: async () => {
				probes++;
				return { tcp: held, http: false };
			},
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 93)?.state === "unhealthy");
		const before = probes;
		await Bun.sleep(100);
		expect(probes).toBeGreaterThan(before);
		expect(spawns).toBe(0);
		expect(kills).toBe(0);
		expect(stateOf(sup, 93)?.restartsLastWindow).toBe(0);
		err = null;
		await waitFor(() => spawns === 1);
		expect(kills).toBe(1);
		expect(stateOf(sup, 93)?.preflightError).toBeNull();
		sup.stop();
		await done;
	});

	test("a corrupt budget fails closed before any spawn @unit", () => {
		const f = files();
		writeFileSync(`${f.statusFile}.restart-budget.json`, "broken");
		expect(() => new Supervisor([], f)).toThrow(
			"Cannot restore supervisor restart budget",
		);
	});

	test("crash loop backs off exponentially @unit", async () => {
		const at: number[] = [];
		const t: Target = {
			name: "crashy",
			port: 1,
			kind: "specialist",
			owned: true,
			bindTimeoutMs: 100,
			spawn: () => {
				at.push(Date.now());
				return crashingChild();
			},
		};
		const sup = new Supervisor([t], {
			...files(),
			...fast,
			backoffBaseMs: 40,
			maxRestarts: 50,
			probe: down,
		});
		const done = start(sup);
		await waitFor(() => at.length >= 5, 10_000);
		sup.stop();
		await done;
		const gaps = at.slice(1).map((v, i) => v - (at[i] as number));
		// 80 → 160 → 320 → 640 (base·2^n), each strictly longer than the last
		for (let i = 1; i < gaps.length; i++)
			expect(gaps[i] as number).toBeGreaterThan(gaps[i - 1] as number);
		expect(gaps[3] as number).toBeGreaterThanOrEqual(600);
	}, 15_000);

	test("circuit breaker stops respawning after N restarts and marks unhealthy @unit", async () => {
		let spawns = 0;
		const t: Target = {
			name: "router-shim",
			port: 2,
			kind: "router",
			owned: true,
			bindTimeoutMs: 50,
			spawn: () => {
				spawns++;
				return crashingChild();
			},
		};
		const f = files();
		const sup = new Supervisor([t], {
			...f,
			...fast,
			backoffBaseMs: 5,
			maxRestarts: 3,
			probe: down,
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 2)?.state === "unhealthy");
		await Bun.sleep(300); // many more intervals: no fork-bomb
		expect(spawns).toBe(3);
		const s = stateOf(sup, 2);
		expect(s?.state).toBe("unhealthy");
		expect(s?.alert).toBe(true);
		expect(s?.restartsLastWindow).toBe(3);
		expect(s?.lastError).toContain("circuit open");
		// unhealthy logged once, not once per interval
		const log = readFileSync(f.logFile, "utf8");
		expect(log.match(/→unhealthy/g)?.length).toBe(1);
		sup.stop();
		await done;
	});

	test("hung router (port bound, no HTTP) is killed and respawned; specialists are not @unit", async () => {
		let healthy = false;
		let routerHeld = true; // hung router holds :10 until killPort releases it
		const killed: number[] = [];
		const spawned: number[] = [];
		const mk = (port: number, killHung: boolean): Target => ({
			name: `t${port}`,
			port,
			kind: port === 10 ? "router" : "specialist",
			owned: true,
			killHung,
			bindTimeoutMs: 100,
			spawn: () => {
				spawned.push(port);
				if (port === 10) {
					healthy = true;
					routerHeld = true;
				}
				return { pid: 1234, exited: new Promise(() => {}), kill: () => {} };
			},
		});
		const sup = new Supervisor([mk(10, true), mk(11, false)], {
			...files(),
			...fast,
			probe: async (t) => ({
				tcp: t.port === 10 ? routerHeld : true,
				http: t.port === 10 ? healthy : false,
			}),
			killPort: (p) => {
				killed.push(p);
				if (p === 10) routerHeld = false; // port release, as the kernel does
			},
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 10)?.state === "up" && healthy);
		await Bun.sleep(200);
		expect(killed).toEqual([10]);
		expect(spawned).toEqual([10]);
		expect(stateOf(sup, 11)?.state).toBe("degraded");
		sup.stop();
		await done;
	});

	test("external + on-demand targets are report-only — never spawned @unit", async () => {
		const sup = new Supervisor(
			[
				{ name: "kev", port: 20, kind: "external", owned: false },
				{ name: "gateway", port: 21, kind: "external", owned: false },
				{ name: "danish", port: 22, kind: "ondemand", owned: false },
			],
			{ ...files(), ...fast, probe: down },
		);
		const done = start(sup);
		await waitFor(() => stateOf(sup, 22)?.state === "idle");
		await waitFor(() => stateOf(sup, 20)?.state === "down");
		expect(stateOf(sup, 20)?.alert).toBe(true);
		expect(stateOf(sup, 22)?.alert).toBe(false);
		expect(stateOf(sup, 20)?.restarts).toBe(0);
		sup.stop();
		await done;
	});
});

test.describe("watchdog liveness report", () => {
	const targets: Target[] = [
		{ name: "router-shim", port: 4000, kind: "router", owned: true },
		{ name: "kev", port: 8912, kind: "external", owned: false },
		{ name: "danish", port: 8906, kind: "ondemand", owned: false },
	];
	const probe = async (t: Target): Promise<ProbeResult> =>
		t.port === 4000 ? { tcp: true, http: true } : { tcp: false, http: false };

	test("no supervisor → loud alert; external down alerts; on-demand idle quiet @unit", async () => {
		const r = await livenessReport({ targets, probe, status: null });
		expect(r.supervisor.stale).toBe(true);
		expect(r.alerts[0]).toContain("supervisor not running");
		expect(r.alerts.some((a) => a.includes(":8912"))).toBe(true);
		expect(r.alerts.some((a) => a.includes(":8906"))).toBe(false);
		expect(renderLiveness(r)).toContain("supervisor: DOWN");
	});

	test("fresh supervisor status merges restarts + breaker state @unit", async () => {
		const now = Date.parse("2026-10-03T08:45:00Z");
		const status: StatusDoc = {
			version: 1,
			supervisorPid: 4242,
			updated: new Date(now - 1000).toISOString(),
			intervalMs: 5000,
			targets: [
				{
					name: "router-shim",
					port: 4000,
					kind: "router",
					owned: true,
					state: "unhealthy",
					alert: true,
					since: new Date(now - 60_000).toISOString(),
					lastProbe: null,
					lastOk: null,
					restarts: 6,
					restartsLastWindow: 6,
					pid: null,
					nextRetryAt: null,
					lastError: "circuit open",
				},
			],
		};
		const r = await livenessReport({
			targets,
			probe,
			status,
			now,
			alive: () => true,
		});
		expect(r.supervisor).toEqual({ pid: 4242, alive: true, stale: false });
		const row = r.rows.find((x) => x.port === 4000);
		expect(row?.restarts).toBe(6);
		expect(row?.alert).toBe(true);
		expect(r.alerts.some((a) => a.includes("circuit open"))).toBe(true);
	});
});
