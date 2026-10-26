// W371 — the hub-heal loop: down→heal→up on a flippable stub probe, the
// quiet-hours hold, degraded (tcp-no-http) rides without healing, and the
// restart breaker opens into "unhealthy" (alerting) after maxRestarts.
// Injected probe/heal only — no real sockets, no real docker.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlert, Supervisor, type Target } from "../bin/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "w371l-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fast = {
	random: () => 1,
	intervalMs: 20,
	failThreshold: 2,
	backoffBaseMs: 10,
	backoffCapMs: 200,
	stableMs: 60_000,
	bindPollMs: 10,
};

const mkHub = (heal: Target["heal"], quiet: () => boolean): Target => ({
	name: "NAS",
	port: 4101,
	kind: "hub",
	owned: false,
	host: "nas.example.lan",
	healthPath: "/api/health",
	heal,
	quietHours: quiet,
	bindTimeoutMs: 500,
});

let probeUp = false;
let probeHttp = false;
let healCalls = 0;
const running: Supervisor[] = [];
test.afterEach(() => {
	for (const s of running.splice(0)) s.stop();
	probeUp = false;
	probeHttp = false;
	healCalls = 0;
});

const start = (sup: Supervisor): void => {
	running.push(sup);
	void sup.run();
};

const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
		await Bun.sleep(15);
	}
};

const stateOf = (sup: Supervisor, name: string) =>
	sup.snapshot().targets.find((t) => t.name === name);

test.describe("hub heal loop", () => {
	test("down → heal → up (restarts counted) @unit", async () => {
		const sup = new Supervisor(
			[
				mkHub(
					async () => {
						healCalls++;
						probeUp = true;
						probeHttp = true;
						return null;
					},
					() => false,
				),
			],
			{
				...fast,
				statusFile: join(dir, "s1.json"),
				logFile: join(dir, "s1.log"),
				probe: async () => ({ tcp: probeUp, http: probeUp && probeHttp }),
			},
		);
		start(sup);
		await waitFor(() => stateOf(sup, "NAS")?.state === "up");
		expect(healCalls).toBe(1);
		expect(stateOf(sup, "NAS")?.restarts).toBe(1);
	});

	test("quiet hours → down without healing, no alert @unit", async () => {
		const sup = new Supervisor(
			[
				mkHub(
					async () => {
						healCalls++;
						return null;
					},
					() => true,
				),
			],
			{
				...fast,
				statusFile: join(dir, "s2.json"),
				logFile: join(dir, "s2.log"),
				probe: async () => ({ tcp: false, http: false }),
			},
		);
		start(sup);
		await Bun.sleep(120);
		expect(healCalls).toBe(0);
		expect(stateOf(sup, "NAS")?.state).toBe("down");
		expect(isAlert("hub", false, "down")).toBe(false);
	});

	test("degraded (tcp no http) rides without healing @unit", async () => {
		probeUp = true;
		probeHttp = false;
		const sup = new Supervisor(
			[
				mkHub(
					async () => {
						healCalls++;
						probeHttp = true;
						return null;
					},
					() => false,
				),
			],
			{
				...fast,
				statusFile: join(dir, "s3.json"),
				logFile: join(dir, "s3.log"),
				probe: async () => ({ tcp: probeUp, http: probeUp && probeHttp }),
			},
		);
		start(sup);
		await Bun.sleep(120);
		expect(healCalls).toBe(0);
		expect(stateOf(sup, "NAS")?.state).toBe("degraded");
	});

	test("circuit opens → unhealthy (alerts), heal held @unit", async () => {
		const sup = new Supervisor(
			[
				mkHub(
					async () => {
						healCalls++;
						return "compose up exit 1: boom";
					},
					() => false,
				),
			],
			{
				...fast,
				maxRestarts: 2,
				statusFile: join(dir, "s4.json"),
				logFile: join(dir, "s4.log"),
				probe: async () => ({ tcp: false, http: false }),
			},
		);
		start(sup);
		await waitFor(() => stateOf(sup, "NAS")?.state === "unhealthy");
		expect(healCalls).toBe(2);
		expect(stateOf(sup, "NAS")?.restarts).toBe(2);
		expect(isAlert("hub", false, "unhealthy")).toBe(true);
	});
});
