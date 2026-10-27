import { expect, test } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityRegistryFromCatalogs,
	collectModelCapabilities,
} from "../bin/model-capability-collector.ts";
import { readCapabilitySnapshot } from "../bin/model-capabilities.ts";
import type { ModelAccess } from "../bin/model-access.ts";

const at = "2026-10-20T12:00:00.000Z";
const now = Date.parse(at);
const dirList: string[] = [];
test.afterEach(async () => {
	await Promise.all(
		dirList.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const access = (): ModelAccess => ({
	ts: at,
	openrouter: {
		state: "catalog reachable",
		source: "https://openrouter.ai/api/v1/models",
		fetchedAt: at,
		models: [
			{
				id: "vendor/model",
				name: "Model",
				price: {
					status: "priced",
					inputUsdPerMillion: 1,
					outputUsdPerMillion: 2,
					requestUsd: null,
				},
			},
		],
	},
	zaiPricing: {
		state: "pricing reachable",
		source: "https://docs.z.ai/guides/overview/pricing.md",
		fetchedAt: at,
		models: [
			{
				id: "glm-5",
				name: "GLM-5",
				price: {
					status: "priced",
					inputUsdPerMillion: 1,
					outputUsdPerMillion: 3,
					requestUsd: null,
				},
			},
		],
	},
	zaiAccount: {
		state: "available",
		source: "https://api.z.ai/api/paas/v4/models",
		generatedAt: at,
		modelIds: ["glm-5", "glm-5-turbo"],
	},
	copilot: {
		state: "catalog reachable",
		models: [
			{
				id: "claude-sonnet-5.5",
				name: "Sonnet",
				vendor: "anthropic",
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
});

test("joins capability and price evidence only by exact provider/model identity @unit", () => {
	const registry = capabilityRegistryFromCatalogs(
		access(),
		{
			data: [
				{
					id: "vendor/model",
					context_length: 131072,
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					supported_parameters: ["tools"],
				},
				{ id: "vendor/other", context_length: 8192 },
			],
		},
		now,
	);
	expect(
		registry.get("openrouter", "vendor/model", 1000, now)?.contextTokens.value,
	).toBe(131072);
	expect(
		registry.get("openrouter", "vendor/model", 1000, now)?.cost.value
			?.inputUsdPerMillion,
	).toBe(1);
	expect(
		registry.get("openrouter", "vendor/other", 1000, now)?.cost.value,
	).toBeNull();
	expect(
		registry.get("zai", "glm-5", 1000, now)?.cost.value?.outputUsdPerMillion,
	).toBe(3);
	expect(registry.get("zai", "glm-5-turbo", 1000, now)?.cost.value).toBeNull();
	expect(
		registry.get("copilot", "claude-sonnet-5.5", 1000, now)?.cost.value?.status,
	).toBe("included-unreported");
});

test("writes an atomic private snapshot and reports an unreachable catalog honestly @unit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "belt-collector-"));
	dirList.push(dir);
	const path = join(dir, "model-capabilities.json");
	const fetcher = async () =>
		new Response(
			JSON.stringify({
				data: [
					{
						id: "vendor/model",
						context_length: 4096,
						architecture: { input_modalities: ["text"] },
					},
				],
			}),
			{ status: 200 },
		);
	const first = await collectModelCapabilities(access(), {
		fetcher,
		path,
		now,
	});
	expect(first.state).toBe("available");
	expect(first.sources.persistence).toBe("saved");
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect((await readCapabilitySnapshot(path)).state).toBe("available");
	const failedFetch = async () => {
		throw new Error("offline");
	};
	const later = await collectModelCapabilities(access(), {
		fetcher: failedFetch,
		path,
		now: now + 16 * 60_000,
	});
	expect(later.state).toBe("partial");
	expect(later.sources.openrouter).toBe("unavailable");
	expect(
		later.records.find(
			(row) => row.provider === "openrouter" && row.modelId === "vendor/model",
		)?.contextTokens.value,
	).toBeNull();
});

test("keeps Z.ai account locality until its 24-hour snapshot expires @unit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "belt-collector-zai-"));
	dirList.push(dir);
	const path = join(dir, "model-capabilities.json");
	const inventory = access();
	inventory.zaiAccount.generatedAt = new Date(now - 30 * 60_000).toISOString();
	inventory.zaiPricing.fetchedAt = inventory.zaiAccount.generatedAt;
	const fetcher = async () => new Response(JSON.stringify({ data: [] }));
	const pricingOnly = access();
	pricingOnly.zaiPricing.fetchedAt = inventory.zaiAccount.generatedAt;
	pricingOnly.zaiAccount = {
		state: "unavailable",
		source: null,
		generatedAt: null,
		modelIds: [],
	};
	await collectModelCapabilities(pricingOnly, { fetcher, path, now });
	const current = await collectModelCapabilities(inventory, {
		fetcher,
		path,
		now,
	});
	for (const id of ["glm-5", "glm-5-turbo"]) {
		const row = current.records.find(
			(record) => record.provider === "zai" && record.modelId === id,
		);
		expect(row?.locality.value).toBe("remote");
		expect(row?.locality.source).toBe(inventory.zaiAccount.source);
		if (id === "glm-5") expect(row.cost.value).toBeNull();
	}
	const expired = await collectModelCapabilities(inventory, {
		fetcher,
		path,
		now: now + 24 * 60 * 60_000,
	});
	expect(
		expired.records.find(
			(record) => record.provider === "zai" && record.modelId === "glm-5",
		)?.locality.value,
	).toBeNull();
});
