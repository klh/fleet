// test/models-route-pools.e2e.ts — W2635: /v1/models rows carry admission
// numbers for models bound to an explicit provider pool (the concurrency/
// connection caps a map.prefer pin will queue or shed against). Pure
// app.fetch tests over testDeps with a provider_pools policy — zero
// network, the admission snapshot is the router's real one.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import { parsePolicy } from "../src/policy.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";

test.describe("@api", () => {
	const poolOf = (capped: Deployment[], plain: Deployment[]): UpstreamPool => ({
		groups: () => ["glm-5.3", "gpt-6-sol"],
		deployments: (g) => (g === "glm-5.3" ? capped : plain),
	});

	const POLICY = parsePolicy(
		JSON.stringify({
			gateway: {
				num_retries: 0,
				provider_pools: {
					"zai-coding-account": {
						concurrency: 8,
						intervalCap: 50,
						intervalMs: 1000,
						maxOutstanding: 64,
						queueWaitMs: 30_000,
						recovery: { successWindow: 8, decreasePercent: 5 },
					},
				},
			},
		}),
	);

	const capped: Deployment[] = [
		{
			group: "glm-5.3",
			url: "https://api.z.ai",
			dialect: "anthropic",
			adapter_config: { provider_pool: "zai-coding-account" },
		},
	];
	const plain: Deployment[] = [
		{ group: "gpt-6-sol", url: "https://api.invalid", dialect: "openai" },
	];

	test("pool-bound model carries admission numbers; pool-less stays bare", async () => {
		const app = createApp(testDeps(poolOf(capped, plain), { policy: POLICY }));
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			data: Array<{
				id: string;
				admission?: {
					provider_pool: string;
					concurrency: number;
					concurrency_ceiling: number;
					outstanding: number;
					queued: number;
					active: number;
					max_outstanding: number;
					rate_per_interval: number;
					interval_ms: number;
				};
			}>;
		};
		const glm = out.data.find((m) => m.id === "glm-5.3");
		expect(glm?.admission).toEqual({
			provider_pool: "zai-coding-account",
			concurrency: 8,
			concurrency_ceiling: 8,
			outstanding: 0,
			queued: 0,
			active: 0,
			max_outstanding: 64,
			rate_per_interval: 50,
			interval_ms: 1000,
		});
		const bare = out.data.find((m) => m.id === "gpt-6-sol");
		expect(bare?.admission).toBeUndefined();
	});

	test("a model split across pools reports no numbers (no single honest value)", async () => {
		const split: Deployment[] = [
			...capped,
			{
				group: "glm-5.3",
				url: "https://api.other.invalid",
				dialect: "openai",
				adapter_config: { provider_pool: "another-account" },
			},
		];
		// both pools declared (the router fail-closes on an unbound id — a
		// different, louder failure than the one under test here)
		const twoPoolPolicy = parsePolicy(
			JSON.stringify({
				gateway: {
					num_retries: 0,
					provider_pools: {
						...POLICY.provider_pools,
						"another-account": POLICY.provider_pools?.["zai-coding-account"],
					},
				},
			}),
		);
		const app = createApp(
			testDeps(poolOf(split, plain), { policy: twoPoolPolicy }),
		);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			data: Array<{ id: string; admission?: unknown }>;
		};
		expect(out.data.find((m) => m.id === "glm-5.3")?.admission).toBeUndefined();
	});
});
