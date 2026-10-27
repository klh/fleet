import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRouterFreeRows } from "../bin/openrouter-free-rows.ts";
import { scratchWorld } from "../../test-kit/src/index.ts";

const { home: dir, clean } = scratchWorld({ prefix: "openrouter-rows-" });
const file = join(dir, "catalog.json");
const now = Date.parse("2026-10-20T10:00:00Z");
const valid = {
	version: 1,
	source: "https://openrouter.ai/api/v1/models?output_modalities=all",
	account_source: "https://openrouter.ai/api/v1/models/user",
	generated_at: new Date(now).toISOString(),
	groups: {
		"openrouter/nvidia/nemotron:free": [
			{ model: "openrouter/nvidia/nemotron:free" },
		],
	},
};

test("LiteLLM receives one free model row with its Buckle wire alias", () => {
	writeFileSync(file, JSON.stringify(valid));
	expect(openRouterFreeRows(file, now)).toEqual([
		'  - model_name: "openrouter/nvidia/nemotron:free"\n    litellm_params:\n      model: "openrouter/nvidia/nemotron:free"\n      api_key: os.environ/OPENROUTER_API_KEY',
	]);
});

test("stale, paid-looking, and mismatched routes cannot enter LiteLLM", () => {
	writeFileSync(file, JSON.stringify(valid));
	expect(() => openRouterFreeRows(file, now + 2 * 60 * 60 * 1000 + 1)).toThrow(
		/stale/,
	);
	writeFileSync(
		file,
		JSON.stringify({
			...valid,
			groups: {
				"openrouter/vendor/paid": [{ model: "openrouter/vendor/paid" }],
			},
		}),
	);
	expect(() => openRouterFreeRows(file, now)).toThrow(/invalid/);
	writeFileSync(
		file,
		JSON.stringify({
			...valid,
			groups: { "openrouter/vendor/free:free": [{ model: "other" }] },
		}),
	);
	expect(() => openRouterFreeRows(file, now)).toThrow(/invalid/);
});

test("missing snapshot leaves the optional provider absent", () => {
	expect(openRouterFreeRows(join(dir, "missing.json"), now)).toEqual([]);
});

test("free router is a distinct LiteLLM alias for the OpenRouter meta model", () => {
	writeFileSync(
		file,
		JSON.stringify({
			...valid,
			groups: { "openrouter/free": [{ model: "openrouter/free" }] },
		}),
	);
	expect(openRouterFreeRows(file, now)).toEqual([
		'  - model_name: "openrouter/free"\n    litellm_params:\n      model: "openrouter/openrouter/free"\n      api_key: os.environ/OPENROUTER_API_KEY',
	]);
});

test("cleanup", () => clean());
