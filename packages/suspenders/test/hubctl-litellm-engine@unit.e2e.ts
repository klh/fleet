import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HubProfileSchema } from "../hooks/lib/stack-config.ts";
import { renderUpstreams, renderEngineCatalog } from "../deploy/hubctl.ts";
import { pushProfileEnv } from "../deploy/hub-profiles.ts";

/** W3081: buckle is a FRONT for litellm (owner law 2026-11-13). The
 *  rendered ladder NEVER hands buckle a provider URL — every provider
 *  row rides the local engine leg — and the engine catalog is rendered
 *  from the same walk. Copilot rows map to litellm's native
 *  github_copilot provider (the /chat/completions endpoint 400s
 *  responses-only models like gpt-6-astra; the engine translates). */

const COPILOT_HUB = {
	name: "ikea",
	host: "fixture.example",
	buckle_port: 4201,
	board_port: 7793,
	store_port: 7795,
	belt_port: 7788,
	upstreams: {
		groups: {
			"gpt-6-astra": [
				{
					url: "https://api.githubcopilot.com",
					model: "gpt-6-astra",
					dialect: "openai",
					api_key_env: "GITHUB_COPILOT_PAT",
					adapter_config: {
						path_rewrite: { "/v1/chat/completions": "/chat/completions" },
					},
				},
			],
			"claude-sonnet-5": [
				{
					url: "https://api.githubcopilot.com",
					model: "claude-sonnet-5.5",
					dialect: "anthropic",
					api_key_env: "GITHUB_COPILOT_PAT",
				},
			],
		},
	},
};

test("provider rows ride the engine leg; loopback peer rows stay direct", () => {
	const hub = HubProfileSchema.parse(COPILOT_HUB);
	const rendered = JSON.parse(renderUpstreams(hub, []));
	for (const rows of Object.values(
		rendered.groups as Record<string, Record<string, unknown>[]>,
	)) {
		for (const row of rows) {
			if (typeof row.url !== "string") continue;
			if (row.url.startsWith("http://127.0.0.1:")) continue; // engine/peer legs
			// any provider-facing row left in the ladder is a law violation
			expect(
				row.url,
				"rendered ladder carries a provider URL (buckle must front litellm)",
			).not.toMatch(/^https?:\/\/api\./);
		}
	}
	const astra = rendered.groups["gpt-6-astra"]?.[0];
	expect(astra?.url).toBe("http://127.0.0.1:4100");
	expect(astra?.dialect).toBe("openai");
	expect(astra?.api_key_env).toBe("LITELLM_KEY");
	expect(astra?.model).toBe("gpt-6-astra");
});

test("engine catalog maps copilot rows to the native github_copilot provider", () => {
	const hub = HubProfileSchema.parse(COPILOT_HUB);
	const { catalog, copilot } = renderEngineCatalog(hub, []);
	expect(copilot).toBe(true);
	expect(catalog).toContain("model: github_copilot/gpt-6-astra");
	expect(catalog).toContain("model_name: gpt-6-astra");
	expect(catalog).toContain("model_name: claude-sonnet-5.5");
	expect(catalog).toContain("master_key: os.environ/LITELLM_KEY");
	expect(catalog).toContain("drop_params: true");
	// secrets never ride the catalog body
	expect(catalog).not.toMatch(/bksk_|ghp_|gho_/);
});

test("non-copilot provider rows map to openai-wire passthrough with env indirection", () => {
	const hub = HubProfileSchema.parse({
		...COPILOT_HUB,
		upstreams: {
			groups: {
				"glm-5.3": [
					{
						url: "https://api.z.ai/v1",
						model: "glm-5.3",
						dialect: "openai",
						api_key_env: "ZAI_KEY",
					},
				],
			},
		},
	});
	const { catalog, copilot } = renderEngineCatalog(hub, []);
	expect(copilot).toBe(false);
	expect(catalog).toContain("model: openai/glm-5.3");
	expect(catalog).toContain("api_base: https://api.z.ai/v1");
	expect(catalog).toContain("api_key: os.environ/ZAI_KEY");
});

test("anthropic-dialect non-copilot provider rows fail loud (engine fronts openai wire)", () => {
	const hub = HubProfileSchema.parse({
		...COPILOT_HUB,
		upstreams: {
			groups: {
				"some-model": [
					{
						url: "https://provider.example",
						model: "some-model",
						dialect: "anthropic",
						api_key_env: "PROVIDER_KEY",
					},
				],
			},
		},
	});
	expect(() => renderUpstreams(hub, [])).toThrow(/openai-wire/);
});

test("peer buckle legs (loopback) are never rewritten onto the engine", () => {
	const hub = HubProfileSchema.parse({
		...COPILOT_HUB,
		upstreams: {
			groups: {
				peer: [
					{
						url: "http://127.0.0.1:4111",
						model: "claude-sonnet-5.5",
						dialect: "anthropic",
						buckle: true,
					},
				],
			},
		},
	});
	const rendered = JSON.parse(renderUpstreams(hub, []));
	expect(rendered.groups.peer[0].url).toBe("http://127.0.0.1:4111");
});

/** W3081 shape law: minimal = buckle + litellm + GUI; full = the
 *  historical container set. */
function profilesOf(hub: unknown): string[] {
	const env: Record<string, string> = {};
	pushProfileEnv(HubProfileSchema.parse(hub), (k, v) => {
		if (v !== undefined && v !== null) env[k] = String(v);
	});
	return (env.COMPOSE_PROFILES ?? "").split(",").filter(Boolean);
}

test("the engine is CORE — never a profile, in any shape", () => {
	for (const shape of [undefined, "minimal"]) {
		const profiles = profilesOf({
			...COPILOT_HUB,
			...(shape ? { shape } : {}),
		});
		expect(
			profiles,
			`shape=${shape ?? "full"} must not profile-gate the engine`,
		).not.toContain("litellm");
	}
	// and the compose template carries no litellm profile gate at all
	const compose = readFileSync(
		join(__dirname, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(compose).not.toContain("profiles: [litellm]");
});

test("minimal shape composes ONLY buckle(+engine) + gui", () => {
	const profiles = profilesOf({
		...COPILOT_HUB,
		shape: "minimal",
		gui: { image: "ghcr.io/klh/hub-gui:0" },
	});
	expect(profiles).toEqual(["gui"]);
});

test("full shape keeps the historical services (default unchanged)", () => {
	const profiles = profilesOf(COPILOT_HUB);
	expect(profiles).toContain("board");
	expect(profiles).toContain("store");
	expect(profiles).toContain("belt");
	expect(profiles).toContain("model-store");
	expect(profiles).not.toContain("litellm");
});

test("gui declared without an image fails loud", () => {
	// the schema requires image — the malformed case is caught at parse
	expect(() =>
		HubProfileSchema.parse({ ...COPILOT_HUB, gui: {} as never }),
	).toThrow();
});
