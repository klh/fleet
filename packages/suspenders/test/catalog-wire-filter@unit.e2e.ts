import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { connectionModelRow } from "../deploy/connection-model-row.ts";

test("declared Responses adapter keeps its published Responses-only model", () => {
	const profile = resolveProvider(
		"selected",
		validateProviderConfig({
			selected: {
				kind: "provider",
				provider: "copilot",
				adapter: "openai-responses",
				endpoints: { openai: "https://responses.example" },
			},
		}),
	);
	if (!profile) throw Error("Profile absent");
	const listing = {
		state: "listed" as const,
		kind: "copilot" as const,
		source: "https://responses.example/models",
		observedAt: new Date().toISOString(),
		rows: new Map([
			[
				"exact-model",
				{ id: "exact-model", supported_endpoints: ["/v1/responses"] },
			],
		]),
	};
	expect(connectionModelRow(profile, listing, "exact-model")).toMatchObject({
		model: "exact-model",
		dialect: "openai",
	});
});

test("Z.ai known non-chat IDs do not become chat identity routes", () => {
	const profile = resolveProvider(
		"selected",
		validateProviderConfig({
			selected: {
				kind: "provider",
				provider: "zai",
				adapter: "openai",
				endpoints: { openai: "https://zai.example/v4" },
			},
		}),
	);
	if (!profile) throw Error("Profile absent");
	const listing = {
		state: "listed" as const,
		kind: "zai" as const,
		source: "https://zai.example/models",
		observedAt: new Date().toISOString(),
		rows: new Map([
			["glm-5.3", null],
			["embedding-3", null],
		]),
	};
	expect(connectionModelRow(profile, listing, "embedding-3")).toBeNull();
	expect(connectionModelRow(profile, listing, "glm-5.3")).toMatchObject({
		model: "glm-5.3",
	});
});
