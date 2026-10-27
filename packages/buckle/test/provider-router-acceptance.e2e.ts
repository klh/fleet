import { expect, test } from "@playwright/test";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const config = {
	concurrency: 1,
	intervalCap: 100,
	intervalMs: 100,
	maxOutstanding: 4,
	queueWaitMs: 1000,
	recovery: { successWindow: 8, decreasePercent: 5 },
};
const pool: UpstreamPool = {
	groups: () => ["alias-a", "alias-b"],
	deployments: (group) => [
		{
			group,
			url: "https://example.invalid",
			dialect: "anthropic",
			adapter_config: { provider_pool: "account" },
		},
	],
};
const request = (group: string, signal?: AbortSignal) => ({
	group,
	dialect: "anthropic" as const,
	path: "/v1/messages",
	body: { model: group, stream: true },
	key: "",
	signal,
});
test.describe({ tag: "@unit" }, () => {
	test("account aliases share a lease until the response body reaches EOF", async () => {
		let close!: () => void;
		let starts = 0;
		const router = new Router(
			{ num_retries: 0, provider_pools: { account: config } },
			{
				pool,
				fetchImpl: async () => {
					starts++;
					return starts === 1
						? new Response(
								new ReadableStream<Uint8Array>({
									start(c) {
										c.enqueue(new TextEncoder().encode("one"));
										close = () => c.close();
									},
								}),
							)
						: new Response("two");
				},
			},
		);
		const first = await router.execute(request("alias-a"));
		expect(first.kind).toBe("upstream");
		if (first.kind !== "upstream") throw new Error("first request failed");
		const secondPromise = router.execute(request("alias-b"));
		await Bun.sleep(15);
		expect(starts).toBe(1);
		close();
		await first.response.text();
		const second = await secondPromise;
		expect(starts).toBe(2);
		expect(second.kind).toBe("upstream");
		if (second.kind === "upstream") await second.response.text();
	});
	test("queued caller cancellation never reaches provider fetch", async () => {
		let close!: () => void;
		let starts = 0;
		const router = new Router(
			{ num_retries: 0, provider_pools: { account: config } },
			{
				pool,
				fetchImpl: async () => {
					starts++;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								close = () => c.close();
							},
						}),
					);
				},
			},
		);
		const first = await router.execute(request("alias-a"));
		const controller = new AbortController();
		const second = router.execute(request("alias-b", controller.signal));
		await Bun.sleep(10);
		controller.abort();
		expect((await second).kind).toBe("aborted");
		expect(starts).toBe(1);
		close();
		if (first.kind === "upstream") await first.response.text();
	});
	test("request frequency is independent of released concurrency", async () => {
		const router = new Router(
			{
				num_retries: 0,
				provider_pools: {
					account: {
						...config,
						concurrency: 2,
						intervalCap: 1,
						intervalMs: 80,
					},
				},
			},
			{ pool, fetchImpl: async () => new Response("ok") },
		);
		const first = await router.execute(request("alias-a"));
		if (first.kind === "upstream") await first.response.text();
		const started = Date.now();
		const second = await router.execute(request("alias-b"));
		expect(Date.now() - started).toBeGreaterThanOrEqual(50);
		if (second.kind === "upstream") await second.response.text();
	});
	test("a bound account without policy is rejected at startup", () => {
		expect(
			() =>
				new Router({}, { pool, fetchImpl: async () => new Response("never") }),
		).toThrow("provider_pool");
	});
});
