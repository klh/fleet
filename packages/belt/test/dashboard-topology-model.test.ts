import { describe, expect, test } from "bun:test";
import { buildTopology } from "../bin/dashboard-topology-model.js";

const now = Date.parse("2026-10-19T12:00:00Z");
const observation = { expiresAt: now + 10_000 };

describe("Belt topology", () => {
	test("joins configured console links and observed local Work Graph counts", () => {
		const model = buildTopology(
			{},
			{},
			{
				observation,
				targets: [{ kind: "hub", name: "NAS", state: "up", port: 4101 }],
			},
			now,
			null,
			null,
			{
				localConsoleUrl: "https://board.example.org/",
				hubConsoles: [{ name: "nas", url: "https://nas.example.org/" }],
				work: {
					ready: 3,
					working: 2,
					waiting: 1,
					blocked: 4,
					failed: 5,
					done: 6,
				},
			},
		);
		expect(model.localConsoleUrl).toBe("https://board.example.org/");
		expect(model.hubs[0]?.consoleUrl).toBe("https://nas.example.org/");
		expect(model.work?.blocked).toBe(4);
	});
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
					{
						machine: "nas",
						model: "qwen",
						ok: true,
						last_seen: "2026-10-19T11:59:00Z",
					},
					{
						machine: "zai",
						model: "glm",
						ok: true,
						last_seen: "2026-10-19T11:59:00Z",
					},
					{ machine: "zai", model: "glm", ok: false },
				],
				routes: [
					{ machine: "zai", ok: true, ts: "2026-10-19T11:57:00Z" },
					{ machine: "nas", ok: true, ts: "2026-10-19T11:00:00Z" },
				],
			},
			{
				observation,
				targets: [
					{
						kind: "hub",
						name: "NAS",
						displayName: "Lab NAS",
						state: "up",
						port: 4101,
					},
				],
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
		expect(model.hubs).toEqual([
			{ name: "NAS", displayName: "Lab NAS", state: "up", port: 4101 },
		]);
		expect(model.machines).toEqual([
			{
				name: "nas",
				endpoints: 1,
				reachable: 1,
				probed: 1,
				routed: 0,
				models: ["qwen"],
				state: "up",
			},
			{
				name: "zai",
				endpoints: 2,
				reachable: 1,
				probed: 1,
				routed: 1,
				models: ["glm"],
				state: "up",
			},
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

	test("configured cloud endpoints without a probe remain unknown", () => {
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [{ machine: "openai", ok: false, last_seen: null }],
			},
			{},
			now,
		);
		expect(model.machines[0]?.state).toBe("unknown");
	});

	test("missing direct API key is unconfigured while Copilot catalog remains separate", () => {
		const copilot = {
			state: "catalog reachable",
			models: [
				{ id: "claude-haiku-4.5", buckle: true, routes: ["claude-haiku-4-5"] },
			],
		};
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [
					{
						machine: "anthropic",
						ok: false,
						reason: "missing api key (ANTHROPIC_API_KEY)",
					},
				],
			},
			{},
			now,
			null,
			{ copilot },
		);
		expect(model.machines[0]?.state).toBe("unconfigured");
		expect(model.copilot).toEqual(copilot);
	});

	test("adds observed Copilot models and measured token rate without inventing a hop", () => {
		const payload = {
			ok: true,
			ts: new Date(now).toISOString(),
			gateway: { state: "up", up: true },
			network: {
				ok: true,
				throughput: {
					interfaces: [
						{
							kind: "cloud",
							host: "api.githubcopilot.com",
							model: "claude-opus-5.5",
							req15: 6,
							req60: 2,
							in60: 90,
							out60: 30,
							lastOkAt: "2026-10-19T11:59:00Z",
						},
					],
				},
			},
		};
		const model = buildTopology(
			{ observation, router: { up: true } },
			{ ts: new Date(now).toISOString(), rows: [], routes: [] },
			{ observation, targets: [] },
			now,
			payload,
		);
		expect(model.gateway).toBe("up");
		expect(model.gatewayTraffic).toEqual({
			requests60: 2,
			inputTokens60: 90,
			outputTokens60: 30,
			observedTargets: 1,
		});
		expect(model.machines).toEqual([
			{
				name: "copilot",
				endpoints: 0,
				reachable: 0,
				routed: 0,
				models: ["claude-opus-5.5"],
				state: "unknown",
				buckleReq15: 6,
				buckleReq60: 2,
				outTokens60: 30,
				routeObserved: true,
			},
		]);
		const stale = buildTopology(
			{},
			{ ts: new Date(now).toISOString(), rows: [], routes: [] },
			{},
			now + 121_000,
			payload,
		);
		expect(stale.gateway).toBe("unknown");
		expect(stale.gatewayTraffic).toBeNull();
		expect(stale.machines).toEqual([]);
	});

	test("summarizes local Buckle routes without assigning them to a cloud provider", () => {
		const model = buildTopology({}, {}, {}, now, {
			ok: true,
			ts: new Date(now).toISOString(),
			network: {
				ok: true,
				throughput: {
					interfaces: [
						{
							kind: "local",
							host: "127.0.0.1",
							model: "glm",
							req60: 7,
							in60: 120,
							out60: 60,
						},
						{
							kind: "local",
							host: "127.0.0.1",
							model: "coder",
							req60: 2,
							in60: 30,
							out60: 10,
						},
					],
				},
			},
		});
		expect(model.gatewayTraffic).toEqual({
			requests60: 9,
			inputTokens60: 150,
			outputTokens60: 70,
			observedTargets: 2,
		});
		expect(model.machines).toEqual([]);
	});

	test("separates configured paths from observed Buckle traffic", () => {
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [
					{
						machine: "zai",
						host: "api.z.ai",
						ok: true,
						last_seen: new Date(now).toISOString(),
						model: "glm-5.3",
					},
					{
						machine: "anthropic",
						host: "api.anthropic.com",
						ok: false,
						reason: "missing api key (ANTHROPIC_API_KEY)",
					},
				],
			},
			{
				observation,
				targets: [{ kind: "hub", name: "NAS", state: "up", port: 4101 }],
			},
			now,
			{
				ok: true,
				ts: new Date(now).toISOString(),
				network: {
					ok: true,
					hops: [
						{
							origin: "local",
							peer: "NAS",
							source: "mac",
							n: 4,
							lastAt: now - 10_000,
						},
					],
					throughput: {
						interfaces: [
							{
								kind: "cloud",
								host: "api.z.ai",
								model: "glm-5.3",
								req15: 8,
								req60: 2,
								in60: 160,
								out60: 80,
								lastOkAt: new Date(now - 10_000).toISOString(),
							},
						],
					},
				},
			},
		);
		expect(model.links).toEqual([
			{ target: "hub:nas", evidence: "observed", requests15: 4 },
			{ target: "provider:zai", evidence: "observed", requests15: 8 },
		]);
		expect(
			model.links.some((link) => link.target === "provider:anthropic"),
		).toBe(false);
	});

	test("keeps one Copilot provider card when catalog and telemetry both report it", () => {
		const model = buildTopology(
			{},
			{ ts: new Date(now).toISOString(), rows: [] },
			{},
			now,
			{
				ok: true,
				ts: new Date(now).toISOString(),
				network: {
					ok: true,
					throughput: {
						interfaces: [
							{
								kind: "cloud",
								host: "api.githubcopilot.com",
								model: "claude-opus-5.5",
								req15: 3,
								req60: 1,
								out60: 30,
								lastOkAt: new Date(now).toISOString(),
							},
						],
					},
				},
			},
			{
				copilot: {
					state: "catalog reachable",
					models: [
						{
							id: "claude-opus-5.5",
							buckle: true,
							routes: ["claude-opus-5-5"],
						},
					],
				},
			},
		);
		expect(
			model.providers.filter((item) => item.key === "copilot"),
		).toHaveLength(1);
		expect(model.providers[0]).toMatchObject({
			key: "copilot",
			buckleReq15: 3,
			routeObserved: true,
		});
		expect(model.links).toEqual([
			{ target: "provider:copilot", evidence: "observed", requests15: 3 },
		]);
	});

	test("does not turn unreported token usage into zero throughput", () => {
		const model = buildTopology({}, {}, {}, now, {
			ok: true,
			ts: new Date(now).toISOString(),
			network: {
				ok: true,
				throughput: {
					interfaces: [
						{
							kind: "local",
							host: "127.0.0.1",
							req60: 0,
							in60: null,
							out60: null,
						},
					],
				},
			},
		});
		expect(model.gatewayTraffic).toEqual({
			requests60: 0,
			inputTokens60: null,
			outputTokens60: null,
			observedTargets: 0,
		});
	});
});
