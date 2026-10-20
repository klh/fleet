import { describe, expect, test } from "bun:test";
import {
	buildTopology,
	observedGraph,
	observedGraphLayout,
} from "../bin/dashboard-topology-model.js";

const now = Date.parse("2026-10-19T12:00:00Z");
const observation = { expiresAt: now + 10_000 };

const snapshot = {
	ok: true,
	schemaVersion: 1,
	observedAt: new Date(now).toISOString(),
	windowStart: new Date(now - 15 * 60_000).toISOString(),
	hubs: [
		{ id: "hub:z", name: "Z hub", lastSeenAt: new Date(now).toISOString() },
		{
			id: "hub:mac",
			name: "This Mac",
			lastSeenAt: new Date(now).toISOString(),
		},
	],
	targets: [
		{
			id: "target:cloud:api.z.ai:443",
			kind: "cloud",
			host: "api.z.ai",
			port: 443,
			lastSeenAt: new Date(now).toISOString(),
		},
	],
	edges: [
		{
			id: "edge:mac->z",
			from: "hub:mac",
			to: "hub:z",
			requests: 1,
			lastSeenAt: new Date(now).toISOString(),
			evidence: "trace",
		},
		{
			id: "edge:mac->endpoint",
			from: "hub:mac",
			to: "target:cloud:api.z.ai:443",
			requests: 1,
			lastSeenAt: new Date(now).toISOString(),
			evidence: "ledger",
		},
	],
	traces: [],
	totals: {
		requests: 1,
		failed: 0,
		active: 0,
		inputTokens: null,
		outputTokens: null,
	},
	coverage: {
		projectionAvailable: true,
		ledgerAvailable: true,
		tokensScope: "unavailable",
	},
};

describe("observed topology snapshot", () => {
	test("uses only reported edges and keeps ledger targets as endpoints", () => {
		const graph = observedGraph({ topology: snapshot }, now);
		expect(graph?.edges).toHaveLength(2);
		expect(graph?.nodes.find((node) => node.kind === "endpoint")?.label).toBe(
			"api.z.ai:443",
		);
		expect(graph?.totals.outputTokens).toBeNull();
		expect(graph?.edges.find((edge) => edge.id === "edge:mac->z")?.fresh).toBe(
			true,
		);
	});

	test("keeps measured zero and local-only usage scope distinct", () => {
		const graph = observedGraph(
			{
				topology: {
					...snapshot,
					totals: { ...snapshot.totals, outputTokens: 0 },
					coverage: {
						...snapshot.coverage,
						tokensScope: "local-origin-ledger",
					},
				},
			},
			now,
		);
		expect(graph?.totals.outputTokens).toBe(0);
		expect(graph?.totals.requests).toBe(1);
	});

	test("retains edge measurements and explicit missing coverage", () => {
		const graph = observedGraph(
			{
				topology: {
					...snapshot,
					edges: [
						{
							...snapshot.edges[0],
							failed: 0,
							active: 1,
							inputTokens: null,
							outputTokens: null,
							coverage: { source: "projection", usageBearingRequests: 0 },
						},
						{
							...snapshot.edges[1],
							failed: 1,
							active: 0,
							inputTokens: 15,
							outputTokens: 1,
							coverage: {
								source: "local-origin-ledger",
								usageBearingRequests: 1,
							},
						},
					],
				},
			},
			now,
		);
		const traceEdge = graph?.edges.find((edge) => edge.id === "edge:mac->z");
		const ledgerEdge = graph?.edges.find(
			(edge) => edge.id === "edge:mac->endpoint",
		);
		expect(traceEdge?.active).toBe(1);
		expect(traceEdge?.outputTokens).toBeNull();
		expect(ledgerEdge?.outputTokens).toBe(1);
		expect(ledgerEdge?.coverage?.source).toBe("local-origin-ledger");
	});

	test("rejects stale or unsupported snapshots", () => {
		expect(
			observedGraph(
				{ topology: { ...snapshot, observedAt: new Date(now - 180_000) } },
				now,
			),
		).toBeNull();
		expect(
			observedGraph({ topology: { ...snapshot, schemaVersion: 2 } }, now),
		).toBeNull();
	});

	test("keeps positions stable when feed order changes", () => {
		const graph = observedGraph({ topology: snapshot }, now);
		const shuffled = observedGraph(
			{
				topology: {
					...snapshot,
					hubs: [...snapshot.hubs].reverse(),
					edges: [...snapshot.edges].reverse(),
				},
			},
			now,
		);
		expect(observedGraphLayout(graph).nodes).toEqual(
			observedGraphLayout(shuffled).nodes,
		);
	});

	test("lays out a hundred observed hubs without overlapping rows", () => {
		const hubs = Array.from({ length: 100 }, (_, index) => ({
			id: `hub:${index.toString().padStart(3, "0")}`,
			name: `Hub ${index}`,
			lastSeenAt: new Date(now).toISOString(),
		}));
		const graph = observedGraph(
			{ topology: { ...snapshot, hubs, targets: [], edges: [] } },
			now,
		);
		const layout = observedGraphLayout(graph);
		expect(layout.nodes).toHaveLength(100);
		expect(
			new Set(layout.nodes.map((node) => `${node.x}:${node.y}`)).size,
		).toBe(100);
		expect(layout.height).toBeGreaterThan(100 * 52);
	});
});

describe("Belt topology", () => {
	test("keeps NAS Immich as a service beside its chat model", () => {
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [
					{
						machine: "nas",
						protocol: "immich",
						port: 2283,
						roles: ["ocr", "embed"],
						ok: true,
						last_seen: now,
					},
					{
						machine: "nas",
						protocol: "openai",
						model: "qwen2.5:0.5b",
						ok: true,
						last_seen: now,
					},
				],
			},
			{
				observation,
				targets: [{ kind: "hub", name: "nas", state: "up", port: 4101 }],
			},
			now,
		);
		expect(model.machines[0]?.models).toEqual(["qwen2.5:0.5b"]);
		expect(model.machines[0]?.services).toEqual([
			{ name: "Immich", port: 2283, roles: ["ocr", "embed"], state: "up" },
		]);
	});

	test("groups gateway routes by hub config while keeping a matching cloud provider", () => {
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [
					{
						machine: "lab",
						host: "api.z.ai",
						port: 443,
						model: "model-a",
						ok: true,
					},
				],
				routes: [],
			},
			{
				observation,
				targets: [{ kind: "hub", name: "lab", state: "up", port: 4301 }],
			},
			now,
			null,
			null,
			{
				hubProviderObservations: [
					{
						hub: "lab",
						provider: "openrouter",
						successes15: 1,
						failures15: 0,
						lastStatus: 200,
						lastAt: new Date(now).toISOString(),
					},
				],
				hubRoutes: [
					{
						name: "lab",
						models: ["model-a"],
						providerHosts: ["api.z.ai"],
						providerHostsByModel: { "model-a": ["api.z.ai"] },
						providerIntents: ["openrouter"],
					},
				],
			},
		);
		expect(model.hubs[0]?.gatewayModels).toEqual(["model-a"]);
		expect(model.hubs[0]?.gatewayRouteCount).toBe(1);
		expect(model.hubs[0]?.gatewayUnresolvedRoutes).toEqual([]);
		expect(model.hubs[0]?.providerKeys).toEqual(["zai"]);
		expect(model.hubs[0]?.providerCounts).toEqual({ zai: 1 });
		expect(model.hubs[0]?.providerIntents).toEqual(["openrouter"]);
		expect(
			model.providers.find((provider) => provider.key === "openrouter")?.state,
		).toBe("unconfigured");
		expect(
			model.providers.find((provider) => provider.key === "openrouter")
				?.hubRequest?.successes15,
		).toBe(1);
		expect(model.providers.some((provider) => provider.key === "zai")).toBe(
			true,
		);
		expect(model.providers.some((provider) => provider.key === "lab")).toBe(
			false,
		);
	});
	test("identifies an OpenRouter hub route through LiteLLM by its model ID", () => {
		const access = {
			openrouter: {
				state: "catalog reachable",
				source: "https://openrouter.ai/api/v1/models",
				fetchedAt: new Date(now).toISOString(),
				models: [
					{
						id: "vendor/model:free",
						price: {
							status: "free",
							inputUsdPerMillion: 0,
							outputUsdPerMillion: 0,
							requestUsd: 0,
						},
					},
				],
			},
		};
		const model = buildTopology(
			{},
			{},
			{
				observation,
				targets: [{ kind: "hub", name: "desktop", state: "up", port: 4111 }],
			},
			now,
			null,
			access,
			{
				hubRoutes: [
					{
						name: "desktop",
						models: ["openrouter/vendor/model:free"],
						providerHosts: ["127.0.0.1"],
						providerHostsByModel: {
							"openrouter/vendor/model:free": ["127.0.0.1"],
						},
						providerModelIds: {
							"openrouter/vendor/model:free": {
								provider: "openrouter",
								id: "vendor/model:free",
							},
						},
						providerIntents: ["openrouter"],
					},
				],
			},
		);
		expect(model.hubs[0]?.providerKeys).toContain("openrouter");
		expect(model.hubs[0]?.providerCounts.openrouter).toBe(1);
		expect(
			model.hubs[0]?.gatewayModelCosts["openrouter/vendor/model:free"],
		).toMatchObject({
			status: "free",
			source: "https://openrouter.ai/api/v1/models",
		});
	});
	test("prices a Z.ai hub model only with exact configured catalog provenance", () => {
		const access = {
			zaiPricing: {
				state: "pricing reachable",
				source: "https://docs.z.ai/guides/overview/pricing",
				fetchedAt: new Date(now).toISOString(),
				models: [
					{
						id: "glm-5.3",
						price: {
							status: "priced",
							inputUsdPerMillion: 1,
							outputUsdPerMillion: 3,
						},
					},
				],
			},
		};
		const context = {
			hubRoutes: [
				{
					name: "zai",
					models: ["zai-glm-5.3", "zai-glm-5.2"],
					providerModelIds: {
						"zai-glm-5.3": { provider: "zai", id: "glm-5.3" },
					},
				},
			],
		};
		const model = buildTopology(
			{},
			{},
			{
				observation,
				targets: [{ kind: "hub", name: "zai", state: "up", port: 4301 }],
			},
			now,
			null,
			access,
			context,
		);
		expect(model.hubs[0]?.gatewayModelCosts["zai-glm-5.3"]).toMatchObject({
			status: "priced",
			inputUsdPerMillion: 1,
		});
		expect(model.hubs[0]?.gatewayModelCosts["zai-glm-5.2"]).toMatchObject({
			status: "unknown",
		});
	});
	test("a same-name provider override has no inferred price or provider", () => {
		const modelName = "openrouter/vendor/model:free";
		const model = buildTopology(
			{},
			{},
			{
				observation,
				targets: [{ kind: "hub", name: "desktop", state: "up", port: 4111 }],
			},
			now,
			null,
			{
				openrouter: {
					state: "catalog reachable",
					source: "https://openrouter.ai/api/v1/models",
					fetchedAt: new Date(now).toISOString(),
					models: [{ id: "vendor/model:free", price: { status: "free" } }],
				},
			},
			{
				hubRoutes: [
					{
						name: "desktop",
						models: [modelName],
						providerHosts: ["elsewhere.example"],
						providerHostsByModel: { [modelName]: ["elsewhere.example"] },
					},
				],
			},
		);
		expect(model.hubs[0]?.gatewayModelCosts[modelName]?.status).toBe("unknown");
		expect(model.hubs[0]?.providerKeys).not.toContain("openrouter");
	});
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
				services: [],
				hosts: [],
				state: "up",
			},
			{
				name: "zai",
				endpoints: 2,
				reachable: 1,
				probed: 1,
				routed: 1,
				models: ["glm"],
				services: [],
				hosts: [],
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
				lastOkAt: "2026-10-19T11:59:00Z",
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
		expect(model.links).toMatchObject([
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
		expect(model.links).toMatchObject([
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

	test("shows measured zero successes and only target-attributed failures", () => {
		const model = buildTopology(
			{},
			{
				ts: new Date(now).toISOString(),
				rows: [
					{
						machine: "zai",
						model: "glm",
						ok: true,
						last_seen: new Date(now).toISOString(),
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
					lastAuditAt: new Date(now - 1_000).toISOString(),
					recentSuccessAt: new Date(now - 3_600_000).toISOString(),
					observations: { available: false },
					throughput: { interfaces: [] },
					audit15: {
						attempts: 8,
						succeeded: 0,
						failed: 8,
						unsettled: 0,
						unattributedFailed: 6,
						failures: [
							{
								kind: "cloud",
								host: "api.z.ai",
								port: null,
								count: 1,
								lastAt: new Date(now).toISOString(),
							},
							{
								kind: "local",
								host: "127.0.0.1",
								port: 4100,
								count: 1,
								lastAt: new Date(now).toISOString(),
							},
							{
								kind: null,
								host: null,
								port: null,
								count: 6,
								lastAt: new Date(now).toISOString(),
							},
						],
					},
				},
			},
		);
		expect(model.audit15).toMatchObject({
			attempts: 8,
			succeeded: 0,
			failed: 8,
		});
		expect(model.links).toMatchObject([
			{
				target: "hub:nas",
				evidence: "probe",
				requests15: null,
				source: "hub observations unavailable",
			},
			{
				target: "provider:zai",
				evidence: "configured",
				requests15: 0,
				failures15: 1,
				source: "local Buckle ledger",
			},
		]);
		expect(model.links.some((link) => link.target === "provider:copilot")).toBe(
			false,
		);
	});
});
