import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { StackConfigSchema } from "../hooks/lib/stack-config.ts";
import { refreshCanonicalUpstreams } from "../deploy/canonical-upstream-refresh.ts";
import { renderUpstreams } from "../deploy/hubctl.ts";
import { discoverConnectionCatalogs } from "../deploy/hub-connection-catalog.ts";

test("canonical maintenance refresh uses checked gateway reload only for changed routes", async () => {
	const profiles = validateProviderConfig({
		selected: {
			kind: "provider",
			provider: "openrouter",
			adapter: "openai",
			endpoints: { openai: "https://refresh-fixture.example/api/v1" },
		},
	});
	const selected = resolveProvider("selected", profiles);
	if (!selected) throw Error("Profile absent");
	const required = [selected],
		stack = StackConfigSchema.parse({
			hubs: {
				fixture: {
					host: "fixture.example",
					deploy: { dir: "/private-owned-fixture" },
					provider_requirements: ["selected"],
				},
			},
		});
	const fetcher = (async () =>
		Response.json({
			data: [{ id: "observed-model" }],
		})) as unknown as typeof fetch;
	let reloads = 0;
	const deps = {
		resolve: () => required,
		fetcher,
		read: () => JSON.stringify({ groups: {}, inherit_defaults: false }),
		reload: (name: string) => {
			expect(name).toBe("fixture");
			reloads++;
		},
	};
	expect(await refreshCanonicalUpstreams(stack, deps)).toEqual([
		"fixture: canonical catalogs reconciled",
	]);
	expect(reloads).toBe(1);
	const hub = stack.hubs.fixture;
	if (!hub) throw Error("Hub absent");
	const rendered = renderUpstreams(
		hub,
		required,
		await discoverConnectionCatalogs(required, fetcher),
	);
	expect(
		await refreshCanonicalUpstreams(stack, { ...deps, read: () => rendered }),
	).toEqual(["fixture: canonical catalogs unchanged"]);
	expect(reloads).toBe(1);
});
