import { expect, test } from "@playwright/test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { Router } from "../src/router.ts";

test.describe({ tag: "@unit" }, () => {
	const policy = {
		concurrency: 40,
		intervalCap: 40,
		intervalMs: 40,
		maxOutstanding: 80,
		queueWaitMs: 2000,
		recovery: { successWindow: 8, decreasePercent: 5 },
	};
	test("one forty-response 429 burst coalesces and stale successes cannot undo it", async () => {
		const core = new ProviderAdmissionCore(policy);
		const leases = await Promise.all(
			Array.from({ length: 40 }, () => core.acquire()),
		);
		for (const lease of leases) lease.feedback?.(429, null);
		expect(core.snapshot()).toMatchObject({
			active: 40,
			rateLimitedTotal: 40,
			feedbackEpoch: 1,
			adaptiveGapMs: 2,
		});
		for (const lease of leases) lease.feedback?.(200, null);
		expect(core.snapshot().adaptiveGapMs).toBe(2);
		for (const lease of leases) lease.release();
		await Bun.sleep(5);
		expect(core.snapshot().outstanding).toBe(0);
	});

	test("adaptive pause retains active leases and obeys caller deadline and cancellation", async () => {
		const core = new ProviderAdmissionCore(policy);
		const active = await core.acquire();
		active.feedback?.(429, 1);
		const cancelled = new AbortController();
		const abort = core.acquire(cancelled.signal).catch((error) => error);
		cancelled.abort(new Error("caller cancelled"));
		expect((await abort).message).toBe("caller cancelled");
		const expired = await core.acquire(undefined, 20).catch((error) => error);
		expect(expired.name).toBe("TimeoutError");
		expect(core.snapshot().active).toBe(1);
		active.release();
		await Bun.sleep(5);
		expect(core.snapshot().outstanding).toBe(0);
	});

	test("only current-epoch successes gradually recover, unrelated failures do not throttle", async () => {
		const core = new ProviderAdmissionCore(policy);
		const first = await core.acquire();
		first.feedback?.(500, null);
		expect(core.snapshot().adaptiveGapMs).toBe(1);
		first.feedback?.(429, null);
		first.release();
		await Bun.sleep(
			Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 1,
		);
		for (let i = 0; i < 8; i++) {
			const lease = await core.acquire();
			lease.feedback?.(200, null);
			lease.release();
		}
		expect(core.snapshot().adaptiveGapMs).toBeGreaterThan(1);
		expect(core.snapshot().adaptiveGapMs).toBeLessThan(2);
	});

	test("maximum adaptive backoff still grants within a shorter caller budget", async () => {
		const core = new ProviderAdmissionCore({ ...policy, queueWaitMs: 400 });
		for (let i = 0; i < 10; i++) {
			const lease = await core.acquire(undefined, 150);
			lease.feedback?.(429, null);
			lease.release();
			await Bun.sleep(
				Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 1,
			);
		}
		// W1273: max backoff is 16x the base pace (here 16ms) — the admission
		// wait no longer sets the ceiling.
		expect(core.snapshot().adaptiveGapMs).toBe(16);
		const started = Date.now();
		const lease = await core.acquire(undefined, 150);
		expect(Date.now() - started).toBeLessThan(150);
		lease.release();
	}, 3000);

	test("forty concurrent callers share adaptive pacing against a real-clock one-request-per-second provider", async () => {
		let lastAccepted = 0;
		let accepted = 0;
		let rejected = 0;
		const router = new Router(
			{
				num_retries: 12,
				allowed_fails: 1000,
				request_timeout_s: 90,
				first_byte_budget_s: 90,
				provider_pools: {
					account: {
						concurrency: 40,
						intervalCap: 1,
						intervalMs: 500,
						maxOutstanding: 80,
						queueWaitMs: 90_000,
						recovery: { successWindow: 8, decreasePercent: 5 },
					},
				},
			},
			{
				pool: {
					groups: () => ["a", "b"],
					deployments: (group) => [
						{
							group,
							url: "https://fixture.invalid",
							dialect: "anthropic",
							adapter_config: { provider_pool: "account" },
						},
					],
				},
				sleepMs: async () => {},
				fetchImpl: async () => {
					const now = Date.now();
					if (now - lastAccepted < 1000) {
						rejected++;
						return Response.json(
							{
								error: {
									code: "1302",
									message: "Rate limit reached for requests",
								},
							},
							{ status: 429 },
						);
					}
					lastAccepted = now;
					accepted++;
					return new Response("useful result");
				},
			},
		);
		const responses = await Promise.all(
			Array.from({ length: 40 }, async (_, index) => {
				const response = await router.execute({
					group: index % 2 ? "a" : "b",
					dialect: "anthropic",
					path: "/v1/messages",
					key: "",
					body: { stream: false },
				});
				if (response.kind !== "upstream")
					throw new Error(`caller failed: ${response.kind}`);
				return response.response.text();
			}),
		);
		expect(responses).toHaveLength(40);
		expect(responses.every((body) => body === "useful result")).toBe(true);
		expect(accepted).toBe(40);
		expect(rejected).toBeLessThan(12);
		expect(router.providerAdmissionSnapshot().account?.rateLimitedTotal).toBe(
			rejected,
		);
	}, 90_000);
});
