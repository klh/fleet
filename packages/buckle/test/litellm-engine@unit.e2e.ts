import { expect, test } from "@playwright/test";
import {
	materializeEngineGroups,
	copilotModelsFromGroups,
	isProviderRow,
} from "../src/litellm-engine.ts";

/** W3081: the ONE mapping in the fleet — how a buckle ladder projects
 *  onto a litellm engine (buckle is the front, litellm the engine).
 *  Contract tests for the module every hub render rides through. */

test("copilot rows: engine leg + native provider catalog row from one walk", () => {
	const { groups, catalog, copilot } = materializeEngineGroups({
		"gpt-6-astra": [
			{
				url: "https://api.githubcopilot.com",
				model: "gpt-6-astra",
				dialect: "openai",
				api_key_env: "GITHUB_COPILOT_PAT",
			},
		],
	});
	expect(copilot).toBe(true);
	expect(groups["gpt-6-astra"]?.[0]).toMatchObject({
		url: "http://127.0.0.1:4100",
		model: "gpt-6-astra",
		dialect: "openai",
		api_key_env: "LITELLM_KEY",
	});
	expect(catalog).toContain("model: github_copilot/gpt-6-astra");
	expect(catalog).toContain("master_key: os.environ/LITELLM_KEY");
});

test("loopback rows (peers, swarm) are never engine-bound", () => {
	expect(isProviderRow({ url: "http://127.0.0.1:4111" })).toBe(false);
	expect(isProviderRow({ url: "http://localhost:8902/v1" })).toBe(false);
	expect(isProviderRow({ url: "https://api.z.ai/v1" })).toBe(true);
	const { groups, catalog } = materializeEngineGroups({
		swarm: [{ url: "http://127.0.0.1:8902/v1", model: "local-x" }],
	});
	expect(groups.swarm?.[0]?.url).toBe("http://127.0.0.1:8902/v1");
	expect(catalog).not.toContain("local-x");
});

test("keyless provider rows drop from both artifacts (never rideable)", () => {
	const { groups, catalog } = materializeEngineGroups({
		g: [{ url: "https://api.z.ai/v1", model: "glm-5.3", dialect: "openai" }],
	});
	expect(groups.g).toEqual([]);
	expect(catalog).not.toContain("glm-5.3");
});

test("copilotModelsFromGroups extracts sorted unique copilot model ids", () => {
	expect(
		copilotModelsFromGroups({
			b: [{ url: "https://api.githubcopilot.com", model: "m2" }],
			a: [
				{ url: "https://api.githubcopilot.com", model: "m1" },
				{ url: "https://api.githubcopilot.com", model: "m2" },
				{ url: "https://api.z.ai/v1", model: "z1" },
			],
		}),
	).toEqual(["m1", "m2"]);
});
