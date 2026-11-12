import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { renderUpstreams } from "../deploy/hubctl.ts";
import { HubProfileSchema } from "../hooks/lib/stack-config.ts";

test("actual hub renderer derives identity routes from provider and peer catalogs without a retired relay", () => {
	const profiles = validateProviderConfig({
		primary: {
			kind: "provider",
			provider: "fixture",
			adapter: "openai-compat",
			protocol: "openai",
			endpoints: { openai: "https://primary.example/v1" },
			default_model: "glm-5.3",
		},
		peer: {
			kind: "buckle",
			adapter: "buckle",
			protocol: "openai",
			endpoints: { openai: "https://peer.example" },
		},
		failed: {
			kind: "provider",
			provider: "fixture",
			adapter: "openai-compat",
			protocol: "openai",
			endpoints: { openai: "https://failed.example/v1" },
		},
	});
	const required = Object.keys(profiles).map((name) => {
		const r = resolveProvider(name, profiles);
		if (!r) throw Error("Profile absent");
		return r;
	});
	const hub = HubProfileSchema.parse({
		host: "fixture.example",
		upstreams: {
			groups: {
				"zai-glm-5.3": [
					{
						providerProfile: "primary",
						dialect: "openai",
						model: "glm-5.3",
						url: "http://127.0.0.1:4100",
					},
				],
			},
		},
	});
	const listed = (source: string, id: string) => ({
		state: "listed" as const,
		kind: "openai" as const,
		source,
		observedAt: new Date().toISOString(),
		rows: new Map([[id, { id }]]),
	});
	const catalogs = new Map([
		["primary", listed("https://primary.example/v1/models", "glm-5.3")],
		["peer", listed("https://peer.example/v1/models", "peer-model")],
	]);
	const result = JSON.parse(renderUpstreams(hub, required, catalogs));
	expect(result.groups["glm-5.3"]).toEqual([
		expect.objectContaining({
			model: "glm-5.3",
			url: "https://primary.example/v1",
			providerProfile: "primary",
		}),
	]);
	expect(result.groups["zai-glm-5.3"]).toEqual(result.groups["glm-5.3"]);
	expect(result.groups["peer-model"]).toEqual([
		expect.objectContaining({
			model: "peer-model",
			buckle: true,
			url: "https://peer.example",
		}),
	]);
	expect(JSON.stringify(result.groups)).not.toContain(":4100");
	expect(result.catalog_status.failed.state).toBe("unavailable");
	expect(result.groups["glm-5.3"][0].capabilities).toBeUndefined();
});
