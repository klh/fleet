import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CapabilityRegistry,
	currentCapability,
	fromLocalSpecialist,
	fromOpenRouterCatalogRow,
	fromRemoteCatalogId,
	readCapabilitySnapshot,
	writeCapabilitySnapshot,
} from "../bin/model-capabilities.ts";

const observedAt = "2026-10-20T12:00:00.000Z";
const observedMs = Date.parse(observedAt);
const temporaryDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("sourced model capabilities", () => {
	test("reads only explicit OpenRouter facts and keeps absent features unknown", () => {
		const row = fromOpenRouterCatalogRow(
			{
				id: "vendor/model:free",
				context_length: 128_000,
				top_provider: { context_length: 96_000, max_completion_tokens: 8192 },
				architecture: {
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				supported_parameters: ["tools", "response_format"],
			},
			observedAt,
		);
		expect(row?.provider).toBe("openrouter");
		expect(row?.modelId).toBe("vendor/model:free");
		expect(row?.contextTokens.value).toBe(96_000);
		expect(row?.maxOutputTokens.value).toBe(8192);
		expect(row?.inputModalities.value).toEqual(["text", "image"]);
		expect(row?.tools.value).toBe(true);
		expect(row?.structuredOutput.value).toBeNull();
		expect(row?.cost.value).toBeNull();
		expect(row?.contextTokens.source).toBe(
			"https://openrouter.ai/api/v1/models",
		);
	});

	test("keeps exact provider and model IDs separate", () => {
		const registry = new CapabilityRegistry();
		const openrouter = fromRemoteCatalogId(
			"openrouter",
			"same-name",
			"catalog-A",
			observedAt,
		);
		const zai = fromRemoteCatalogId(
			"zai",
			"same-name",
			"catalog-B",
			observedAt,
		);
		if (!openrouter || !zai) throw new Error("fixture invalid");
		registry.upsert(openrouter);
		registry.upsert(zai);
		expect(
			registry.get("openrouter", "same-name", 1000, observedMs)?.locality
				.source,
		).toBe("catalog-A");
		expect(
			registry.get("zai", "same-name", 1000, observedMs)?.locality.source,
		).toBe("catalog-B");
		expect(registry.get("copilot", "same-name", 1000, observedMs)).toBeNull();
	});

	test("joins cost only by exact model ID and keeps independently sourced facts", () => {
		const source = "https://openrouter.ai/api/v1/models";
		const price = {
			value: {
				status: "free" as const,
				inputUsdPerMillion: 0,
				outputUsdPerMillion: 0,
				requestUsd: 0,
			},
			source,
			observedAt,
		};
		const wrong = fromOpenRouterCatalogRow({ id: "vendor/other" }, observedAt, {
			modelId: "vendor/target",
			fact: price,
		});
		expect(wrong?.cost.value).toBeNull();
		const right = fromOpenRouterCatalogRow(
			{ id: "vendor/target" },
			observedAt,
			{ modelId: "vendor/target", fact: price },
		);
		expect(right?.cost.value?.status).toBe("free");
		const registry = new CapabilityRegistry();
		if (!right) throw new Error("fixture invalid");
		registry.upsert(right);
		const sparse = fromRemoteCatalogId(
			"openrouter",
			"vendor/target",
			"inventory",
			observedAt,
		);
		if (!sparse) throw new Error("fixture invalid");
		registry.upsert(sparse);
		expect(
			registry.get("openrouter", "vendor/target", 1000, observedMs)?.cost.value
				?.status,
		).toBe("free");
	});

	test("expires each fact to unknown while retaining provenance", () => {
		const local = fromLocalSpecialist(
			{ model: "exact/checkpoint", contextTokens: 32_768 },
			observedAt,
		);
		if (!local) throw new Error("fixture invalid");
		expect(local.cost.value?.status).toBe("local-unpriced");
		const expired = currentCapability(local, 1000, observedMs + 1001);
		expect(expired.contextTokens.value).toBeNull();
		expect(expired.contextTokens.source).toBe("belt:registry");
		expect(expired.contextTokens.observedAt).toBe(observedAt);
		expect(expired.cost.value).toBeNull();
		expect(
			currentCapability(local, 1000, observedMs + 1000).contextTokens.value,
		).toBe(32_768);
		expect(
			currentCapability(local, 1000, observedMs - 1).contextTokens.value,
		).toBeNull();
	});

	test("persists atomically as mode 0600 and reloads across process boundaries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "belt-capabilities-"));
		temporaryDirs.push(dir);
		const path = join(dir, "inventory", "capabilities.json");
		const local = fromLocalSpecialist(
			{ model: "local/model", contextTokens: 4096 },
			observedAt,
		);
		if (!local) throw new Error("fixture invalid");
		await writeCapabilitySnapshot(
			path,
			new CapabilityRegistry([local]),
			observedMs,
		);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const saved = await readCapabilitySnapshot(path);
		expect(saved.state).toBe("available");
		expect(
			saved.registry.get("belt-local", "local/model", 1000, observedMs)
				?.contextTokens.value,
		).toBe(4096);
		expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
	});

	test("rejects invalid snapshots and distinguishes missing files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "belt-capabilities-"));
		temporaryDirs.push(dir);
		const path = join(dir, "capabilities.json");
		expect((await readCapabilitySnapshot(path)).state).toBe("missing");
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				savedAt: observedAt,
				records: [{ provider: "zai" }],
			}),
		);
		expect((await readCapabilitySnapshot(path)).state).toBe("invalid");
	});
});
