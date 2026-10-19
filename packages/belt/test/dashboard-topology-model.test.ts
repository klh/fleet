import { describe, expect, test } from "bun:test";
import { buildTopology } from "../bin/dashboard-topology-model.js";

const now = Date.parse("2026-10-19T12:00:00Z");
const observation = { expiresAt: now + 10_000 };

describe("Belt topology", () => {
	test("keeps probed reachability separate from recent routed traffic", () => {
		const model = buildTopology(
			{
				observation,
				router: { up: true },
				specialists: [
					{
						role: "code",
						port: 8901,
						model_served: "coder",
						load_5m: 3,
						state_label: "ready",
					},
					{
						role: "embed",
						port: 8907,
						load_5m: 0,
						state_label: "idle · on demand",
					},
				],
			},
			{
				ts: "2026-10-19T11:59:00Z",
				rows: [
					{ machine: "nas", ok: true },
					{ machine: "zai", ok: true },
					{ machine: "zai", ok: false },
				],
				routes: [
					{ machine: "zai", ok: true, ts: "2026-10-19T11:57:00Z" },
					{ machine: "nas", ok: true, ts: "2026-10-19T11:00:00Z" },
				],
			},
			{
				observation,
				targets: [{ kind: "hub", name: "NAS", state: "up", port: 4101 }],
			},
			now,
		);
		expect(model.router).toBe("up");
		expect(model.specialists).toMatchObject({
			ready: 1,
			idle: 1,
			attention: 0,
		});
		expect(model.specialists.models).toEqual([
			{
				role: "code",
				port: 8901,
				model: "coder",
				load5m: 3,
				label: "ready",
				state: "up",
			},
			{
				role: "embed",
				port: 8907,
				model: "model not loaded",
				load5m: 0,
				label: "idle · on demand",
				state: "idle",
			},
		]);
		expect(model.hubs).toEqual([{ name: "NAS", state: "up", port: 4101 }]);
		expect(model.machines).toEqual([
			{ name: "nas", endpoints: 1, reachable: 1, routed: 0, state: "up" },
			{ name: "zai", endpoints: 2, reachable: 1, routed: 1, state: "up" },
		]);
	});

	test("does not show stale observations as live", () => {
		const model = buildTopology(
			{ observation: { expiresAt: now - 1 }, router: { up: true } },
			{ ts: "2026-10-19T11:00:00Z", rows: [{ machine: "nas", ok: true }] },
			{
				observation: { expiresAt: now - 1 },
				targets: [{ kind: "hub", name: "NAS", state: "up" }],
			},
			now,
		);
		expect(model.router).toBe("unknown");
		expect(model.hubs[0]?.state).toBe("unknown");
		expect(model.machines[0]?.state).toBe("unknown");
	});
});
