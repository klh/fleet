import { expect, test } from "@playwright/test";
import { buildModelInventory } from "../bin/model-inventory.ts";
import { emptyCapability } from "../bin/model-capabilities.ts";

test.describe("unified Belt model inventory", () => {
	test("joins NAS probe and hub configuration without inventing health @unit", () => {
		const now = Date.parse("2026-10-20T17:00:00Z");
		const inventory = buildModelInventory(
			{
				remotes: [
					{
						machine: "NAS",
						host: "192.0.2.10",
						port: 11434,
						protocol: "openai",
						model: "qwen2.5:0.5b",
						models: ["qwen2.5:0.5b"],
						ok: true,
						last_seen: now,
					},
				],
				remoteObservedAt: new Date(now).toISOString(),
				hubs: [
					{
						name: "NAS",
						models: ["qwen2.5:0.5b"],
						routeCount: 1,
						unresolvedRoutes: [],
						providerIntents: [],
						routesByModel: { "qwen2.5:0.5b": ["general"] },
						providerHosts: ["127.0.0.1"],
						providerHostsByModel: { "qwen2.5:0.5b": ["127.0.0.1"] },
						targetPortsByModel: { "qwen2.5:0.5b": [11434] },
						providerModelIds: {},
					},
				],
			},
			now,
		);
		expect(inventory.models).toHaveLength(1);
		expect(inventory.models[0]?.exposures).toEqual([
			{
				owner: "NAS",
				kind: "hub",
				evidence: "configured",
				state: "unknown",
				routeModel: "qwen2.5:0.5b",
				routes: ["general"],
			},
			{
				owner: "NAS",
				kind: "remote",
				evidence: "probe",
				state: "up",
				endpoint: "192.0.2.10:11434",
				observedAt: "2026-10-20T17:00:00.000Z",
			},
		]);
	});

	test("does not treat stale local observations or provider catalogs as live @unit", () => {
		const now = Date.parse("2026-10-20T17:00:00Z");
		const inventory = buildModelInventory(
			{
				specialists: [
					{
						role: "code",
						port: 8901,
						model_served: "Qwen3-Coder",
						state_label: "ready",
					},
				],
				localObservedAt: now - 180_000,
				access: {
					ts: new Date(now).toISOString(),
					openrouter: {
						state: "catalog reachable",
						source: "test",
						fetchedAt: new Date(now).toISOString(),
						models: [],
					},
					zaiPricing: {
						state: "pricing unavailable",
						source: "test",
						fetchedAt: null,
						models: [],
					},
					zaiAccount: {
						state: "unavailable",
						source: null,
						generatedAt: null,
						modelIds: [],
					},
					copilot: {
						state: "catalog reachable",
						models: [
							{
								id: "claude-sonnet",
								name: "Claude",
								vendor: "Anthropic",
								endpoints: [],
								buckle: false,
								routes: [],
								price: {
									status: "included-unreported",
									inputUsdPerMillion: null,
									outputUsdPerMillion: null,
									requestUsd: null,
								},
							},
						],
					},
					personal: { claude: "unobserved", chatgpt: "unobserved" },
				},
			},
			now,
		);
		expect(
			inventory.models.find((row) => row.id === "Qwen3-Coder")?.exposures[0]
				?.state,
		).toBe("unknown");
		expect(
			inventory.models.find((row) => row.id === "claude-sonnet")?.exposures[0],
		).toMatchObject({ evidence: "catalog", state: "unknown" });
	});

	test("keeps the same model ID separate across providers @unit", () => {
		const inventory = buildModelInventory({
			hubs: [
				{
					name: "Muramasa",
					models: ["chatgpt/gpt-6-sol"],
					routeCount: 1,
					unresolvedRoutes: [],
					providerIntents: ["chatgpt", "copilot"],
					routesByModel: { "chatgpt/gpt-6-sol": ["chatgpt/gpt-6-sol"] },
					providerHosts: [],
					providerHostsByModel: {},
					targetPortsByModel: {},
					providerModelIds: {},
				},
			],
			capabilities: [emptyCapability("chatgpt", "gpt-6-sol")],
			access: {
				ts: new Date().toISOString(),
				openrouter: {
					state: "catalog unavailable",
					source: "test",
					fetchedAt: null,
					models: [],
				},
				zaiPricing: {
					state: "pricing unavailable",
					source: "test",
					fetchedAt: null,
					models: [],
				},
				zaiAccount: {
					state: "unavailable",
					source: null,
					generatedAt: null,
					modelIds: [],
				},
				copilot: {
					state: "catalog reachable",
					models: [
						{
							id: "gpt-6-sol",
							name: "GPT",
							vendor: "OpenAI",
							endpoints: [],
							buckle: false,
							routes: [],
							price: {
								status: "included-unreported",
								inputUsdPerMillion: null,
								outputUsdPerMillion: null,
								requestUsd: null,
							},
						},
					],
				},
				personal: { claude: "unobserved", chatgpt: "unobserved" },
			},
		});
		expect(inventory.models.map((row) => row.key)).toEqual([
			"chatgpt:gpt-6-sol",
			"copilot:gpt-6-sol",
		]);
		expect(inventory.models[0]?.capability?.provider).toBe("chatgpt");
		expect(inventory.models[1]?.capability).toBeUndefined();
	});
});
