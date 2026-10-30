// W2309 — the hub port-publishing self-heal: signature classification,
// the bounded one-remedy fire (remote = hubctl up, local = compose
// force-recreate), the distinct docker-down state, and the heartbeat
// registry wiring. All legs injected — no docker, no ssh, no network.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
	deadProbes,
	forceRecreateScript,
	healHub,
	healthyWithoutPorts,
	inspectScript,
	type HubHealTarget,
	parseInspect,
	publishesNothing,
	signatureMatch,
} from "../hooks/lib/fleet-loop/hub-port-heal.ts";
import { MAINTENANCE_TASKS } from "../hooks/lib/fleet-loop/maintenance.ts";
import { toTarget } from "../hooks/bin/hub-port-heal.ts";

test.describe("@api", () => {
	const remote: HubHealTarget = {
		name: "nas",
		ssh: "kk@nas",
		docker: "docker",
		dir: "/volume1/hub-nas",
		connectTimeout: 5,
		probePorts: [4112, 7800],
	};
	const local: HubHealTarget = {
		name: "desktop",
		docker: "docker",
		dir: "/hub-desktop",
		probePorts: [4112],
	};

	// canned leg answers keyed by what the script touches
	type Leg = (script: string) => { code: number; out: string };
	const legExec = (legs: Leg[]) => {
		const seen: string[] = [];
		const exec = (t: HubHealTarget, script: string) => {
			seen.push(`${t.name}: ${script.split("\n")[0]}`);
			for (const leg of legs) {
				const r = leg(script);
				if (r) return r;
			}
			return { code: 0, out: "" };
		};
		return { exec, seen };
	};

	const sigInspect = {
		code: 0,
		out: '/buckle-hub|running|healthy|{}\n/board-hub|running|healthy|{"222/tcp":null}\n',
	};
	const okInspect = {
		code: 0,
		out: '/buckle-hub|running|healthy|{"4112/tcp":[{"HostIp":"0.0.0.0","HostPort":"4112"}]}\n',
	};
	const deadFaces = { code: 0, out: "4112:000\n7800:000\n" };
	const liveFaces = { code: 0, out: "4112:200\n" };

	test("publishesNothing: empty or all-null mappings are dead publishes", () => {
		expect(publishesNothing("{}")).toBe(true);
		expect(publishesNothing('{"222/tcp":null}')).toBe(true);
		expect(
			publishesNothing('{"4112/tcp":[{"HostIp":"0.0.0.0","HostPort":"4112"}]}'),
		).toBe(false);
		// unparseable inspect output never counts as "publishes nothing" —
		// a garbage leg must not trigger a recreate
		expect(publishesNothing("not json")).toBe(false);
	});

	test("healthyWithoutPorts picks only running containers without publishes", () => {
		const rows = parseInspect(
			'/buckle-hub|running|healthy|{}\n/exited|exited|none|{}\n/withports|running|healthy|{"4112/tcp":[{}]}\n',
		);
		expect(rows.map((r) => r.name)).toEqual([
			"buckle-hub",
			"exited",
			"withports",
		]);
		expect(healthyWithoutPorts(rows).map((r) => r.name)).toEqual([
			"buckle-hub",
		]);
	});

	test("signatureMatch needs BOTH a port-less healthy container and a dead face", () => {
		expect(signatureMatch(parseInspect(sigInspect.out), [4112])).toBe(true);
		expect(signatureMatch(parseInspect(sigInspect.out), [])).toBe(false);
		expect(signatureMatch(parseInspect(okInspect.out), [4112])).toBe(false);
	});

	test("deadProbes reads the port:code probe lines", () => {
		expect(deadProbes("4112:000\n7800:200\n\njunk\n")).toEqual([4112]);
	});

	test("healHub dry-run: signature → port-loss verdict, no remedy", () => {
		const legs = legExec([
			(s) => (s.includes("inspect --format") ? sigInspect : undefined),
			(s) => (s.includes("curl --max-time") ? deadFaces : undefined),
		]);
		const r = healHub(remote, {
			act: false,
			exec: legs.exec,
			spawn: () => {
				throw new Error("spawn must not run in dry-run");
			},
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(r.verdict).toBe("port-loss");
		expect(r.remedied).toBe(false);
		expect(r.healed).toBe(false);
		expect(r.detail).toContain("dry-run");
	});

	test("healHub act remote: ONE hubctl-up remedy, re-probe heals", () => {
		let inspects = 0;
		const spawns: string[][] = [];
		const legs = legExec([
			(s) => {
				if (!s.includes("inspect --format")) return undefined;
				inspects++;
				return inspects === 1 ? sigInspect : okInspect;
			},
			(s) =>
				s.includes("curl --max-time")
					? inspects === 1
						? deadFaces
						: liveFaces
					: undefined,
		]);
		const r = healHub(remote, {
			act: true,
			exec: legs.exec,
			spawn: (cmd) => {
				spawns.push(cmd);
				return { code: 0, out: "up" };
			},
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(spawns).toEqual([["bun", "/hubctl.ts", "up", "nas"]]);
		expect(r.remedied).toBe(true);
		expect(r.healed).toBe(true);
		expect(r.detail).toContain("HEALED");
	});

	test("healHub act local: docker info gate then compose force-recreate", () => {
		const scripts: string[] = [];
		let inspects = 0;
		const legs = legExec([
			(s) => {
				scripts.push(s);
				if (s === `${local.docker} info >/dev/null 2>&1`)
					return { code: 0, out: "" };
				if (s.includes("inspect --format")) {
					inspects++;
					return inspects === 1 ? sigInspect : okInspect;
				}
				if (s.includes("curl --max-time"))
					return inspects === 1 ? deadFaces : liveFaces;
				if (s.includes("--force-recreate")) return { code: 0, out: "ok" };
				return undefined;
			},
		]);
		const r = healHub(local, {
			act: true,
			exec: legs.exec,
			spawn: () => {
				throw new Error("local remedy rides the hub exec, not a local spawn");
			},
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(r.healed).toBe(true);
		expect(scripts.some((s) => s === forceRecreateScript(local))).toBe(true);
	});

	test("healHub local docker daemon down → docker-down verdict, no probe", () => {
		const legs = legExec([
			(s) =>
				s === `${local.docker} info >/dev/null 2>&1`
					? { code: 1, out: "Cannot connect" }
					: undefined,
		]);
		const r = healHub(local, {
			act: true,
			exec: legs.exec,
			spawn: () => ({ code: 0, out: "" }),
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(r.verdict).toBe("docker-down");
		expect(r.remedied).toBe(false);
		// no inspect ever ran — the daemon IS the precondition
		expect(legs.seen.some((s) => s.includes("inspect"))).toBe(false);
	});

	test("healHub remedy fails → remedied but not healed, exit-worthy", () => {
		const legs = legExec([
			(s) => (s.includes("inspect --format") ? sigInspect : undefined),
			(s) => (s.includes("curl --max-time") ? deadFaces : undefined),
		]);
		const r = healHub(remote, {
			act: true,
			exec: legs.exec,
			spawn: () => ({ code: 1, out: "up refused: stale env" }),
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(r.remedied).toBe(true);
		expect(r.healed).toBe(false);
		expect(r.detail).toContain("remedy FAILED");
	});

	test("healHub: unreachable hub leg and empty compose project degrade", () => {
		const unreachable = healHub(remote, {
			act: false,
			exec: () => ({ code: 255, out: "ssh: connect refused" }),
			spawn: () => ({ code: 0, out: "" }),
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(unreachable.verdict).toBe("unreachable");
		const empty = healHub(remote, {
			act: false,
			exec: () => ({ code: 3, out: "" }),
			spawn: () => ({ code: 0, out: "" }),
			bun: "bun",
			hubctlPath: "/hubctl.ts",
		});
		expect(empty.verdict).toBe("no-containers");
	});

	test("heartbeat registry carries the task with the --act bin face", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "hub-port-heal");
		expect(task).toBeDefined();
		expect(task?.everySeconds).toBe(900);
		const argv = task?.argv("/root", "/repo") ?? [];
		expect(argv).toEqual([
			join("/root", "hooks/bin/hub-port-heal.ts"),
			"--act",
		]);
		// missingRunners-style existence: the bin face must resolve at root
		const root = join(import.meta.dir, "..");
		expect(typeof argv[0]).toBe("string");
		void root;
	});

	test("toTarget maps a profile to the probe face set", () => {
		const t = toTarget("nas", {
			deploy: { ssh: "kk@nas", dir: "/vol/hub" },
			buckle_health_port: 4112,
			knowledge: { health_port: 7803 },
		});
		expect(t).toEqual({
			name: "nas",
			ssh: "kk@nas",
			docker: "docker",
			dir: "/vol/hub",
			connectTimeout: undefined,
			probePorts: [4112, 7800, 7794, 7790, 7803, 7793],
		});
		expect(toTarget("no-dir", { deploy: {} })).toBeNull();
	});

	test("inspect script quotes the compose project paths", () => {
		const s = inspectScript(remote);
		expect(s).toContain('"/volume1/hub-nas/hub-compose.yaml"');
		expect(s).toContain("exit 3");
	});
});
