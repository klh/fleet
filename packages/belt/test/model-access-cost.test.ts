import { expect, test } from "bun:test";
import { parseOpenRouterModels } from "../bin/model-access.ts";

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
