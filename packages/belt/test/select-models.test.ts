import { describe, expect, test } from "bun:test";
import {
	CapabilityRegistry,
	type CapabilityFact,
	type ModelPrice,
	defaultCapabilitySnapshotPath,
	fromLocalSpecialist,
	fromOpenRouterCatalogRow,
	fromRemoteCatalogId,
	readCapabilitySnapshot,
} from "../bin/model-capabilities.ts";
import { selectModels, type TaskRequirements } from "../bin/select-models.ts";

const T0 = "2026-10-23T00:00:00.000Z";
const NOW = Date.parse(T0);
const HOUR = 3_600_000;
const SOURCE = "https://openrouter.ai/api/v1/models";

type PriceStatus =
	| "free"
	| "priced"
	| "included-unreported"
	| "local-unpriced"
	| "unknown";

const price = (
	inputUsdPerMillion: number | null,
	status: PriceStatus = "priced",
): CapabilityFact<ModelPrice> => ({
	value: {
		status,
		inputUsdPerMillion,
		outputUsdPerMillion: null,
		requestUsd: null,
	},
	source: SOURCE,
	observedAt: T0,
});

/** OpenRouter catalog row with chosen cost facts (tools/structured on). */
const catalogRow = (
	id: string,
	context: number,
	cost?: CapabilityFact<ModelPrice>,
	observedAt = T0,
): ReturnType<typeof fromOpenRouterCatalogRow> =>
	fromOpenRouterCatalogRow(
		{
			id,
			architecture: {
				input_modalities: ["text", "image"],
				output_modalities: ["text"],
			},
			top_provider: { context_length: context },
			supported_parameters: ["tools", "structured_outputs"],
		},
		observedAt,
		cost ? { modelId: id, fact: cost } : undefined,
	);

const registry = (
	records: Array<ReturnType<typeof fromOpenRouterCatalogRow>>,
) => new CapabilityRegistry(records.filter((r) => r !== null));

const REQ_BASE: TaskRequirements = { maxAgeMs: HOUR };

describe("selectModels (W1030.3)", () => {
	test("positive: must-grade requirements gate on fresh facts and rank by price", () => {
		const cheap = catalogRow("vendor/cheap", 131_072, price(0.02));
		const dear = catalogRow("vendor/dear", 131_072, price(0.5));
		const reg = registry([dear, cheap]);
		const result = selectModels(
			{ ...REQ_BASE, tools: true, structuredOutput: true },
			reg,
			NOW,
		);
		expect(result.selected.map((c) => c.modelId)).toEqual([
			"vendor/cheap",
			"vendor/dear",
		]);
		expect(result.why).toContain("head openrouter/vendor/cheap");
		expect(result.selected[0].reason).toContain("tools");
		expect(result.selected[0].reason).toContain(SOURCE);
		expect(result.selected[0].inputUsdPerMillion).toBe(0.02);
	});

	test("positive: locality preference ranks matching records first, rest stay fallbacks", () => {
		const local = fromLocalSpecialist(
			{ model: "qwen-coder", contextTokens: 32_768 },
			T0,
		);
		const remote = catalogRow("vendor/remote", 131_072);
		const reg = registry([remote, local]);
		const result = selectModels(
			{ ...REQ_BASE, minContextTokens: 32_000 },
			reg,
			NOW,
		);
		const withLocal = selectModels(
			{ ...REQ_BASE, minContextTokens: 32_000, locality: "local" },
			reg,
			NOW,
		);
		// no preference: both placements stay selectable (deterministic order)
		expect(result.selected.map((c) => c.locality).sort()).toEqual([
			"local",
			"remote",
		]);
		// with a preference the matching record heads, the other stays a fallback
		expect(withLocal.selected[0].locality).toBe("local");
		expect(withLocal.selected.map((c) => c.locality)).toContain("remote");
	});

	test("positive: unstated requirements never exclude — unknown structuredOutput is fine when only tools is stated", () => {
		const partial = catalogRow("vendor/partial", 131_072);
		partial.structuredOutput = {
			value: null,
			source: null,
			observedAt: null,
		} as CapabilityFact<boolean>;
		const reg = registry([partial]);
		const result = selectModels({ ...REQ_BASE, tools: true }, reg, NOW);
		expect(result.selected).toHaveLength(1);
	});

	test("positive: complexity text is classified by the preserved Belt classifier", () => {
		const result = selectModels(
			{
				...REQ_BASE,
				complexityText: "refactor this function to fix the race condition",
			},
			new CapabilityRegistry(),
			NOW,
		);
		expect(result.complexity?.tier).toBe("MEDIUM"); // code presence clamps to MEDIUM
		expect(result.complexity?.dimensions.codePresence).toBeGreaterThan(0.5);
	});

	test("negative: an UNKNOWN fact refuses a stated must — never assumed compatible", () => {
		const bare = fromRemoteCatalogId("openrouter", "vendor/bare", SOURCE, T0);
		const reg = registry([bare]);
		const result = selectModels({ ...REQ_BASE, tools: true }, reg, NOW);
		expect(result.selected).toHaveLength(0);
		expect(result.why).toContain("no record satisfies");
		expect(result.why).toContain("refusing rather than substituting");
	});

	test("negative: an EXPIRED fact refuses — freshness gate reads it as unknown", () => {
		const stale = catalogRow(
			"vendor/stale",
			131_072,
			undefined,
			new Date(NOW - 2 * HOUR).toISOString(),
		);
		const reg = registry([stale]);
		const result = selectModels({ ...REQ_BASE, tools: true }, reg, NOW);
		expect(result.selected).toHaveLength(0);
	});

	test("negative: an unverifiable price ceiling excludes — included-unreported and over-ceiling priced never pass", () => {
		const unreported = catalogRow(
			"vendor/unreported",
			131_072,
			price(null, "included-unreported"),
		);
		const over = catalogRow("vendor/over", 131_072, price(5));
		const within = catalogRow("vendor/within", 131_072, price(1));
		const reg = registry([unreported, over, within]);
		const result = selectModels(
			{ ...REQ_BASE, maxInputUsdPerMillion: 2 },
			reg,
			NOW,
		);
		expect(result.selected.map((c) => c.modelId)).toEqual(["vendor/within"]);
	});

	test("negative: unknown context or missing modality refuses a stated must", () => {
		const bare = fromRemoteCatalogId("openrouter", "vendor/bare", SOURCE, T0);
		const reg = registry([bare]);
		expect(
			selectModels({ ...REQ_BASE, minContextTokens: 8_000 }, reg, NOW).selected,
		).toHaveLength(0);
		const textOnly = catalogRow("vendor/text-only", 131_072);
		textOnly.inputModalities = {
			value: ["text"],
			source: SOURCE,
			observedAt: T0,
		};
		const modalityResult = selectModels(
			{ ...REQ_BASE, inputModalities: ["audio"] },
			registry([textOnly]),
			NOW,
		);
		expect(modalityResult.selected).toHaveLength(0);
		expect(modalityResult.why).toContain("input: audio");
	});

	test("negative: empty registry selects nothing and says why — no fabricated benchmark", () => {
		const result = selectModels(
			{ ...REQ_BASE, tools: true },
			new CapabilityRegistry(),
			NOW,
		);
		expect(result.selected).toHaveLength(0);
		expect(result.seen).toBe(0);
		expect(result.why).toContain("no record satisfies");
	});
});

// the snapshot face the CLI rides — same contract, real path resolution
describe("select-models snapshot contract", () => {
	test("default snapshot path resolves under the runtime home", () => {
		expect(defaultCapabilitySnapshotPath()).toContain(
			"model-capabilities.json",
		);
	});

	test("a missing snapshot is an honest empty selection, not a fabrication", async () => {
		const loaded = await readCapabilitySnapshot(
			"/tmp/w1030-3-nonexistent-snapshot.json",
		);
		expect(loaded.state).toBe("missing");
		const result = selectModels(
			{ ...REQ_BASE, tools: true },
			loaded.registry,
			NOW,
		);
		expect(result.selected).toHaveLength(0);
	});
});
