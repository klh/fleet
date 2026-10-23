import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRouterFreeRows } from "../bin/openrouter-free-rows.ts";

const dir = mkdtempSync(join(tmpdir(), "openrouter-rows-"));
const file = join(dir, "catalog.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// W1135.1.7: the old cleanup "test" only rmSync'd the fixture (no
// assertions, order-dependent teardown — that job is afterAll's now). It
// carries a real assertion instead: the fixture stays an mkdtemp dir under
// the OS tmpdir, never a fixed path or a repo-tree write.
test("cleanup", () => {
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir).toMatch(/openrouter-rows-/);
});
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
