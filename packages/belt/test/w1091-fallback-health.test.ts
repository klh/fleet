import { describe, expect, test } from "bun:test";
import {
	groupBasesFromModelList,
	probeDeploymentHealth,
	suppressUnreachableFallbacks,
} from "../bin/fallback-health.ts";
import type { GatewayPolicy } from "../bin/router-policy.ts";

const MODEL_LIST = [
	"model_list:",
	"  - model_name: local-reason",
	"    litellm_params:",
	"      model: openai/qwen",
	"      api_base: http://127.0.0.1:8903/v1",
	"      api_key: local",
	'  - model_name: "glm-5.3-flash"',
	"    litellm_params:",
	"      model: anthropic/glm-5.3-flash",
	'      api_base: "https://api.z.ai/api/anthropic"',
	"      api_key: os.environ/Z_AI_API_KEY",
	"  - model_name: glm-5.3-flash",
	"    litellm_params:",
	"      model: anthropic/local-swarm",
	"      api_base: http://127.0.0.1:4000",
	"      api_key: dummy",
	"  - model_name: local-swarm",
	"    litellm_params:",
	"      model: anthropic/local-swarm",
	"      api_base: http://127.0.0.1:4000",
	"      api_key: dummy",
].join("\n");

describe("groupBasesFromModelList", () => {
	test("maps each model_name to its deduped api_base list", () => {
		const bases = groupBasesFromModelList(MODEL_LIST);
		expect(bases.get("local-reason")).toEqual(["http://127.0.0.1:8903/v1"]);
		expect(bases.get("glm-5.3-flash")).toEqual([
			"https://api.z.ai/api/anthropic",
			"http://127.0.0.1:4000",
		]);
		expect(bases.get("local-swarm")).toEqual(["http://127.0.0.1:4000"]);
		expect(bases.get("missing")).toBeUndefined();
	});
});

const POLICY: GatewayPolicy = {
	fallbacks: {
		"glm-5.3-flash": ["zai-glm-5.3-flash", "local-swarm"],
		"glm-5.3": ["zai-glm-5.3", "local-swarm"],
	},
	context_window_fallbacks: { "local-reason": ["glm-5.3-flash"] },
};

describe("suppressUnreachableFallbacks", () => {
	test("drops probed-dead rungs, keeps live and unknown rungs", () => {
		const bases = groupBasesFromModelList(MODEL_LIST);
		const alive = new Set(["glm-5.3-flash"]);
		const { policy, suppressed } = suppressUnreachableFallbacks(
			POLICY,
			bases,
			alive,
		);
		expect(suppressed).toEqual([
			"glm-5.3-flash: local-swarm",
			"glm-5.3: local-swarm",
		]);
		expect(policy.fallbacks).toEqual({
			"glm-5.3-flash": ["zai-glm-5.3-flash"],
			"glm-5.3": ["zai-glm-5.3"],
		});
		expect(policy.context_window_fallbacks).toEqual(
			POLICY.context_window_fallbacks,
		);
	});

	test("row with every rung dead is dropped whole", () => {
		const bases = new Map([["dead-group", ["http://127.0.0.1:1/v1"]]]);
		const { policy, suppressed } = suppressUnreachableFallbacks(
			{ fallbacks: { "glm-5.3": ["dead-group"] } },
			bases,
			new Set(),
		);
		expect(suppressed).toEqual(["glm-5.3: dead-group"]);
		expect(policy.fallbacks).toEqual({});
	});

	test("never mutates the operator policy object", () => {
		const bases = groupBasesFromModelList(MODEL_LIST);
		suppressUnreachableFallbacks(POLICY, bases, new Set());
		expect(POLICY.fallbacks).toEqual({
			"glm-5.3-flash": ["zai-glm-5.3-flash", "local-swarm"],
			"glm-5.3": ["zai-glm-5.3", "local-swarm"],
		});
	});
});

describe("probeDeploymentHealth", () => {
	test("a group lives when any base answers, dies when all miss", async () => {
		const live = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("ok"),
		});
		const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
		const deadPort = reserve.port;
		reserve.stop(true);
		try {
			const bases = new Map([
				["live-group", [`http://127.0.0.1:${live.port}/v1`]],
				["dead-group", [`http://127.0.0.1:${deadPort}/v1`]],
				[
					"mixed-group",
					[
						`http://127.0.0.1:${deadPort}/v1`,
						`http://127.0.0.1:${live.port}/v1`,
					],
				],
			]);
			expect(await probeDeploymentHealth(bases, 500)).toEqual(
				new Set(["live-group", "mixed-group"]),
			);
		} finally {
			live.stop(true);
		}
	});
});
