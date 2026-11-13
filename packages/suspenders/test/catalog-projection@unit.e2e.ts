import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { renderUpstreams } from "../deploy/hubctl.ts";
import { HubProfileSchema } from "../hooks/lib/stack-config.ts";

test("published Copilot wire and limits constrain generated routes; unknown reasoning is omitted", () => {
	const profiles = validateProviderConfig({
		selected: {
			kind: "provider",
			provider: "github-copilot",
			adapter: "openai",
			auth: { kind: "inline", key: "fixture-key" },
			env: "TEST_COPILOT_KEY",
			endpoints: {
				openai: "https://copilot.example",
				anthropic: "https://copilot.example",
			},
			allowed_models: ["exact-model"],
		},
	});
	const selected = resolveProvider("selected", profiles);
	if (!selected) throw Error("Profile absent");
	const listing = {
		state: "listed" as const,
		kind: "copilot" as const,
		source: "https://api.githubcopilot.com/models",
		observedAt: new Date().toISOString(),
		rows: new Map([
			[
				"exact-model",
				{
					id: "exact-model",
					supported_endpoints: ["/v1/messages"],
					capabilities: {
						limits: {
							max_context_window_tokens: 131072,
							max_output_tokens: 16384,
						},
					},
				},
			],
			["not-allowed", { id: "not-allowed" }],
		]),
	};
	const doc = JSON.parse(
		renderUpstreams(
			HubProfileSchema.parse({ host: "fixture.example" }),
			[selected],
			new Map([["selected", listing]]),
		),
	);
	// W3081: the ladder row is now the ENGINE leg (buckle fronts litellm —
	// owner law): hop fields overridden, projection metadata preserved.
	expect(doc.groups["exact-model"][0]).toMatchObject({
		adapter: "openai-compat",
		dialect: "openai",
		url: "http://127.0.0.1:4100",
		api_key_env: "LITELLM_KEY",
		provider: "github-copilot",
		capabilities: {
			context_length: 131072,
			max_output_tokens: 16384,
			capability_source: "provider-published",
		},
	});
	expect(doc.groups["exact-model"][0].capabilities.reasoning).toBeUndefined();
	expect(doc.groups["not-allowed"]).toEqual([]);
});

test("canonical provider suppresses obsolete snapshot generation and unbound retired relay fallbacks", () => {
	const profiles = validateProviderConfig({
		selected: {
			kind: "provider",
			provider: "openrouter",
			adapter: "openai",
			endpoints: { openai: "https://openrouter.example/api/v1" },
		},
	});
	const selected = resolveProvider("selected", profiles);
	if (!selected) throw Error("Profile absent");
	const hub = HubProfileSchema.parse({
		host: "fixture.example",
		upstreams: {
			openrouter_free_catalog_file: "/does-not-exist",
			groups: {
				dead: [
					{
						url: "http://127.0.0.1:4100",
						dialect: "openai",
						model: "unverified",
					},
				],
			},
		},
	});
	const doc = JSON.parse(renderUpstreams(hub, [selected], new Map()));
	expect(doc.groups.dead).toEqual([]);
	expect(doc.catalog_status["unbound:dead"].state).toBe("unavailable");
	expect(doc.catalog_status.selected.state).toBe("unavailable");
});
