import { expect, test } from "bun:test";
import {
	checkRoutePreflight,
	type RoutePreflightSources,
} from "./route-preflight.ts";

type UpstreamPool = RoutePreflightSources["localPool"];
type Deployment = ReturnType<UpstreamPool["deployments"]>[number];

const pool = (
	groups: Record<string, Array<Omit<Deployment, "group">>>,
): UpstreamPool => ({
	groups: () => Object.keys(groups),
	deployments: (name) =>
		(groups[name] ?? []).map((row) => ({ ...row, group: name })),
});

test("pinned Flash pressure stays on its Coding Plan account and passes activation", async () => {
	const zai = {
		url: "https://api.z.ai",
		model: "glm-5.3-flash",
		api_key_env: "Z_AI_API_KEY",
		dialect: "openai" as const,
		adapter_config: { provider_pool: "zai-coding-plan" },
	};
	const source: RoutePreflightSources = {
		stack: { hubs: { zai: { url: "http://127.0.0.1:4301" } } },
		localPool: pool({
			"glm-5.3-flash": [zai],
			"zai-glm-5.3-flash": [zai],
		}),
		policy: {
			num_retries: 0,
			fallbacks: { "glm-5.3-flash": ["zai-glm-5.3-flash"] },
			provider_pools: {
				"zai-coding-plan": {
					concurrency: 50,
					intervalCap: 100,
					intervalMs: 1000,
					maxOutstanding: 100,
					queueWaitMs: 1000,
					recovery: { successWindow: 8, decreasePercent: 5 },
				},
			},
		},
		litellm: { model_list: [] },
	};
	const result = await checkRoutePreflight(source, async () => true);
	expect(result.findings).toEqual([]);
	expect(result.ok).toBe(true);
	expect(result.drills).toEqual([
		{
			group: "glm-5.3-flash",
			fallback: "zai-glm-5.3-flash",
			failureStatus: 429,
			ok: true,
		},
		{
			group: "glm-5.3-flash",
			fallback: "zai-glm-5.3-flash",
			failureStatus: 503,
			ok: true,
		},
	]);
	source.localPool = pool({ model: [zai], alias: [zai] });
	source.policy.fallbacks = { model: ["alias"] };
	const unpinned = await checkRoutePreflight(source, async () => true);
	expect(unpinned.ok).toBe(false);
	expect(unpinned.drills.find((drill) => drill.failureStatus === 429)?.ok).toBe(
		false,
	);
});
