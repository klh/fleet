import { expect, test } from "bun:test";
import {
	parseOpenRouterModels,
	parseZaiAccountInventory,
	parseZaiPricing,
	zaiPriceForId,
} from "../bin/model-access.ts";

test("OpenRouter rates are converted from USD per token to USD per million", () => {
	const models = parseOpenRouterModels({
		data: [
			{
				id: "example/free:free",
				name: "Free",
				pricing: { prompt: "0", completion: "0", request: "0" },
			},
			{
				id: "example/paid",
				pricing: {
					prompt: "0.00000015",
					completion: "0.0000006",
					request: "0",
				},
			},
			{
				id: "example/request-fee",
				pricing: { prompt: "0", completion: "0", request: "0.01" },
			},
			{
				id: "example/unknown",
				pricing: { prompt: "0", completion: null },
			},
		],
	});
	expect(models.map((model) => model.price.status)).toEqual([
		"free",
		"priced",
		"priced",
		"unknown",
	]);
	expect(models[1]?.price.inputUsdPerMillion).toBeCloseTo(0.15);
	expect(models[1]?.price.outputUsdPerMillion).toBeCloseTo(0.6);
	expect(models[2]?.price.requestUsd).toBe(0.01);
	expect(models[3]?.price.outputUsdPerMillion).toBeNull();
});

test("invalid or missing catalog prices never become FREE", () => {
	const models = parseOpenRouterModels({
		data: [
			{ id: "bad/negative", pricing: { prompt: "-1", completion: "0" } },
			{
				id: "bad/non-numeric",
				pricing: { prompt: "unknown", completion: "0" },
			},
			{ id: "bad/infinite", pricing: { prompt: "Infinity", completion: "0" } },
		],
	});
	expect(models.every((model) => model.price.status === "unknown")).toBe(true);
	expect(() => parseOpenRouterModels({ data: "bad" })).toThrow(
		"catalog data missing",
	);
});

test("Z.ai published USD per million rates match only exact model IDs", () => {
	const models = parseZaiPricing(`Prices per 1M tokens.
| Model | Input | Cached Input | Cached Input Storage | Output |
| GLM-5.3-Flash | \\$0.15 | \\$0.03 | Limited-time Free | \\$0.50 |
  | GLM-4.5-Air | \\$0.2 | \\$0.03 | Limited-time Free | \\$1.1 |
  | GLM-4.7-Flash | Free | Free | Free | Free |
| GLM-Image | \\$0.015 |
`);
	const catalog = {
		state: "pricing reachable" as const,
		source: "https://docs.z.ai/guides/overview/pricing.md",
		fetchedAt: "2026-10-20T00:00:00Z",
		models,
	};
	expect(zaiPriceForId(catalog, "glm-5.3-flash")).toMatchObject({
		status: "priced",
		inputUsdPerMillion: 0.15,
		outputUsdPerMillion: 0.5,
	});
	expect(zaiPriceForId(catalog, "glm-4.5-air")).toMatchObject({
		status: "priced",
		inputUsdPerMillion: 0.2,
		outputUsdPerMillion: 1.1,
	});
	expect(zaiPriceForId(catalog, "glm-4.7-flash").status).toBe("free");
	expect(zaiPriceForId(catalog, "glm-5-turbo").status).toBe("unknown");
	expect(zaiPriceForId(catalog, "glm-5.3").status).toBe("unknown");
	expect(zaiPriceForId(catalog, "GLM-5.3-Flash").status).toBe("unknown");
});

test("Z.ai account inventory contributes IDs without inventing prices", () => {
	const inventory = parseZaiAccountInventory({
		version: 1,
		source: "https://api.z.ai/api/paas/v4/models",
		generated_at: "2026-10-20T00:00:00Z",
		model_ids: ["glm-5-turbo", "glm-5.3-flash", "glm-5.3-flash", "other/model"],
	});
	expect(inventory.state).toBe("available");
	expect(inventory.modelIds).toEqual(["glm-5-turbo", "glm-5.3-flash"]);
	expect(parseZaiAccountInventory({}).state).toBe("unavailable");
});
