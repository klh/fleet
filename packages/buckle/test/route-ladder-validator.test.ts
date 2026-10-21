import { expect, test } from "bun:test";
import { validateRouteLadders } from "../src/route-ladder-validator.ts";
import type { GatewayPolicy } from "../src/policy.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

function pool(
	rows: Record<string, Array<{ url: string; model?: string }>>,
): UpstreamPool {
	return {
		groups: () => Object.keys(rows),
		deployments: (group) =>
			(rows[group] ?? []).map((row) => ({
				...row,
				group,
				dialect: "openai",
			})),
	};
}

const policy: GatewayPolicy = {
	num_retries: 1,
	request_timeout_s: 30,
	retry_after_cap_s: 2,
	fallbacks: { primary: ["backup"] },
};

test("Buckle's bounded fallback rows are not recursively expanded", () => {
	const result = validateRouteLadders({
		buckles: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4101"],
				policy: {
					...policy,
					fallbacks: { primary: ["backup"], backup: ["primary"] },
				},
				pool: pool({
					primary: [{ url: "https://provider.example/v1" }],
					backup: [{ url: "https://other.example/v1" }],
				}),
			},
		],
	});
	expect(result.errors).toEqual([]);
});

test("LiteLLM's recursive fallback cycle is identified with the owning layer", () => {
	const result = validateRouteLadders({
		buckles: [],
		litellms: [
			{
				id: "engine",
				origins: ["http://127.0.0.1:4100"],
				config: {
					model_list: [
						{
							model_name: "a",
							litellm_params: { api_base: "https://a.example" },
						},
						{
							model_name: "b",
							litellm_params: { api_base: "https://b.example" },
						},
					],
					litellm_settings: { fallbacks: [{ a: ["b"] }, { b: ["a"] }] },
				},
			},
		],
	});
	expect(
		result.errors.some(
			(error) => error.code === "cycle" && error.layer === "litellm",
		),
	).toBe(true);
});

test("LiteLLM context-window fallback edges participate in cycle detection", () => {
	const result = validateRouteLadders({
		buckles: [],
		litellms: [
			{
				id: "engine",
				origins: ["http://127.0.0.1:4100"],
				config: {
					model_list: ["a", "b"].map((model_name) => ({
						model_name,
						litellm_params: { api_base: "https://cloud.example" },
					})),
					litellm_settings: {
						fallbacks: [{ a: ["b"] }],
						context_window_fallbacks: [{ b: ["a"] }],
					},
				},
			},
		],
	});
	expect(result.errors.some((error) => error.code === "cycle")).toBe(true);
});

test("current machine policy's symmetric GLM and Z.ai GLM fallback shape is unsafe", () => {
	const result = validateRouteLadders({
		buckles: [],
		litellms: [
			{
				id: "machine-engine",
				origins: ["http://127.0.0.1:4100"],
				config: {
					model_list: ["glm-5.3-flash", "zai-glm-5.3-flash", "local-swarm"].map(
						(model_name) => ({
							model_name,
							litellm_params: { api_base: `https://${model_name}.example` },
						}),
					),
					litellm_settings: {
						fallbacks: [
							{ "glm-5.3-flash": ["zai-glm-5.3-flash", "local-swarm"] },
							{ "zai-glm-5.3-flash": ["glm-5.3-flash", "local-swarm"] },
						],
					},
				},
			},
		],
	});
	expect(
		result.errors.some(
			(error) =>
				error.code === "cycle" && error.detail.includes("zai-glm-5.3-flash"),
		),
	).toBe(true);
});

test("cross-service Belt escalation back into the same Buckle group is a cycle", () => {
	const result = validateRouteLadders({
		buckles: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4101"],
				policy,
				pool: pool({ primary: [{ url: "http://127.0.0.1:4000" }], backup: [] }),
			},
		],
		belts: [
			{
				id: "router",
				origins: ["http://127.0.0.1:4000"],
				escalation: { url: "http://127.0.0.1:4101", model: "primary" },
			},
		],
	});
	expect(result.errors.some((error) => error.code === "cycle")).toBe(true);
});

test("LiteLLM local-swarm preserves the model ID that disables Belt re-escalation", () => {
	const config = {
		model_list: [
			{
				model_name: "glm-5.3-flash",
				litellm_params: {
					model: "zai/glm-5.3-flash",
					api_base: "https://zai.example",
				},
			},
			{
				model_name: "local-swarm",
				litellm_params: {
					model: "anthropic/local-swarm",
					api_base: "http://127.0.0.1:4000",
				},
			},
		],
		litellm_settings: { fallbacks: [{ "glm-5.3-flash": ["local-swarm"] }] },
	};
	const inputs = {
		buckles: [],
		litellms: [{ id: "engine", origins: ["http://127.0.0.1:4100"], config }],
		belts: [
			{
				id: "router",
				origins: ["http://127.0.0.1:4000"],
				escalation: { url: "http://127.0.0.1:4100", model: "glm-5.3-flash" },
				noEscalationModels: ["local-swarm"],
			},
		],
	};
	expect(validateRouteLadders(inputs).errors).toEqual([]);
	expect(
		validateRouteLadders({
			...inputs,
			belts: inputs.belts.map((belt) => ({ ...belt, noEscalationModels: [] })),
		}).errors.some((error) => error.code === "cycle"),
	).toBe(true);
});

test("effective Fleet-selected groups are checked without changing directive order", () => {
	const result = validateRouteLadders({
		buckles: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4101"],
				policy,
				pool: pool({ "glm-5.3-flash": [{ url: "https://zai.example" }] }),
			},
		],
		laneSelections: [
			{ path: ".prefer attempt 0", model: "glm-5.3-flash" },
			{ path: ".prefer attempt 1", model: "claude-haiku-4-5" },
		],
	});
	expect(
		result.errors
			.filter((error) => error.layer === "fleet")
			.map((error) => error.path),
	).toEqual([".prefer attempt 1"]);
});

test("unmapped local target, missing fallback, and retry budget beyond caller deadline fail", () => {
	const result = validateRouteLadders({
		buckles: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4101"],
				policy: { ...policy, fallbacks: { primary: ["missing"] } },
				pool: pool({ primary: [{ url: "http://127.0.0.1:4999" }] }),
			},
		],
		requestDeadlineMs: 10_000,
	});
	expect(result.errors.map((error) => error.code)).toContain(
		"unmapped_local_target",
	);
	expect(result.errors.map((error) => error.code)).toContain(
		"missing_fallback",
	);
	expect(result.errors.map((error) => error.code)).toContain("deadline_budget");
});

test("validator uses the request-wide first-byte budget instead of multiplying retries by ladder length", () => {
	const result = validateRouteLadders({
		buckles: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4101"],
				policy: {
					...policy,
					num_retries: 3,
					request_timeout_s: 120,
					first_byte_budget_s: 240,
					fallbacks: { primary: ["second", "third"] },
				},
				pool: pool({
					primary: [{ url: "https://primary.example.invalid" }],
					second: [{ url: "https://second.example.invalid" }],
					third: [{ url: "https://third.example.invalid" }],
				}),
			},
		],
		requestDeadlineMs: 600_000,
	});
	expect(result.errors.map((error) => error.code)).not.toContain(
		"deadline_budget",
	);
});

test("remote Belt proxy preserves the requested model when linking its configured terminal", () => {
	const base = {
		buckles: [
			{
				id: "nas",
				origins: ["http://127.0.0.1:4101"],
				policy,
				pool: pool({ qwen: [{ url: "http://127.0.0.1:8914" }] }),
			},
		],
		belts: [
			{
				id: "nas-model",
				origins: ["http://127.0.0.1:8914"],
				upstream: "http://127.0.0.1:11434",
			},
		],
	};
	const mapped = validateRouteLadders({
		...base,
		terminalOrigins: ["http://127.0.0.1:11434"],
	});
	expect(mapped.errors).toEqual([]);
	expect(mapped.checkedNodes).toBeGreaterThan(1);
	const missing = validateRouteLadders(base);
	expect(missing.errors.map((error) => error.code)).toContain(
		"unmapped_local_target",
	);
});

test("duplicate service origins are rejected instead of silently selecting one Belt proxy", () => {
	const result = validateRouteLadders({
		buckles: [],
		belts: [
			{ id: "one", origins: ["http://127.0.0.1:8914"] },
			{ id: "two", origins: ["http://127.0.0.1:8914"] },
		],
	});
	expect(result.errors.map((error) => error.code)).toContain("invalid_config");
});
