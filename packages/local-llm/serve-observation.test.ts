import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationFresh } from "./observation.ts";
import {
	probeObservedTarget,
	serveObserver,
	type ObservedTarget,
} from "./serve-observation.ts";

const target = (port: number): ObservedTarget => ({
	name: "test",
	port,
	kind: "external",
	owned: false,
	healthPath: "/health",
});

test("real network probes reject unhealthy bodies and treat gateway 401 as serving", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v1/models")
				return new Response("unauthorized", { status: 401 });
			return Response.json({ ok: false, status: "down" });
		},
	});
	try {
		expect(await probeObservedTarget(target(server.port))).toBe("degraded");
		expect(
			await probeObservedTarget({
				...target(server.port),
				kind: "gateway",
				healthPath: "/v1/models",
				okStatus: [200, 401],
			}),
		).toBe("up");
		const port = server.port;
		server.stop(true);
		expect(await probeObservedTarget(target(port))).toBe("down");
	} finally {
		server.stop(true);
	}
});

test("snapshot refresh preserves actual probe failures, timestamps and ownership", async () => {
	const directory = mkdtempSync(join(tmpdir(), "fleet-serve-observation-"));
	let now = 100_000;
	let failing = false;
	const file = join(directory, "snapshot.json");
	const observe = serveObserver(
		file,
		15_000,
		async () => {
			if (failing) throw new Error("unavailable evidence");
			return "up";
		},
		() => now,
	);
	try {
		const first = await observe([target(1234)]);
		expect(first.source).toBe("local-llm-serve");
		expect(first.targets[0].owned).toBe(false);
		expect(first.targets[0].state).toBe("up");
		expect(first.targets[0].restarts).toBeNull();
		expect(observationFresh(first.targets[0].observation, now + 45_000)).toBe(
			false,
		);
		now += 15_000;
		failing = true;
		const second = await observe([target(1234)]);
		expect(second.updated).not.toBe(first.updated);
		expect(second.targets[0].state).toBe("unknown");
		expect(second.targets[0].lastOk).toBe(first.targets[0].lastOk);
		expect(second.targets[0].observation.observedAt).toBe(now);
		expect(second.targets[0].observation.expiresAt).toBe(now + 45_000);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(second);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("known absence is idle only for on-demand targets and starting only for a live owned child", async () => {
	const directory = mkdtempSync(join(tmpdir(), "fleet-serve-states-"));
	try {
		const observe = serveObserver(
			join(directory, "snapshot.json"),
			15_000,
			async () => "down",
		);
		const targets: ObservedTarget[] = [
			target(1234),
			{ ...target(1235), kind: "ondemand" },
			{ ...target(1236), kind: "specialist", owned: true },
		];
		const doc = await observe(
			targets,
			new Map([[1236, { pid: 1, alive: true, restarts: 2 }]]),
		);
		expect(doc.targets.map((row) => row.state)).toEqual([
			"down",
			"idle",
			"starting",
		]);
		expect(doc.targets[2].restarts).toBe(2);
		expect(doc.targets[2].restartsLastWindow).toBeNull();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
