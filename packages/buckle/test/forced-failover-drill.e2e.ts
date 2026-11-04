import { expect, test } from "@playwright/test";
import { runForcedFailoverDrill } from "../src/forced-failover-drill.ts";

test.describe({ tag: "@unit" }, () => {
	// W1294.17 port delta: playwright has no test.each — the bun .each loop
	// became a for-of registration with the %d title interpolated per case.
	for (const status of [429, 503])
		test(`forced ${status} failover is bounded and attributes the failed layer`, async () => {
			const report = await runForcedFailoverDrill({
				policy: {
					num_retries: 0,
					request_timeout_s: 2,
					retry_after_cap_s: 1,
					fallbacks: { primary: ["local"] },
				},
				pool: {
					groups: () => ["primary", "local"],
					deployments: (group) => [
						{
							group,
							url: `https://${group}.example.invalid`,
							dialect: "openai",
						},
					],
				},
				group: "primary",
				fallback: "local",
				failureStatus: status,
				maxAttempts: 2,
				maxWallMs: 1000,
			});
			expect(report.ok).toBe(true);
			expect(report.deliveredGroup).toBe("local");
			expect(
				report.attempts.map((attempt) => ({
					group: attempt.group,
					status: attempt.status,
					layer: attempt.layer,
				})),
			).toEqual([
				{ group: "primary", status, layer: "buckle" },
				{ group: "local", status: 200, layer: "buckle" },
			]);
			expect(report.attempts[0]?.retryAfterMs).toBe(60_000);
		});

	test("drill rejects a retrying policy that would exceed its attempt budget", async () => {
		await expect(
			runForcedFailoverDrill({
				policy: { num_retries: 1, fallbacks: { primary: ["local"] } },
				pool: {
					groups: () => ["primary", "local"],
					deployments: (group) => [
						{
							group,
							url: `https://${group}.example.invalid`,
							dialect: "openai",
						},
					],
				},
				group: "primary",
				fallback: "local",
				failureStatus: 503,
				maxAttempts: 2,
				maxWallMs: 1000,
			}),
		).rejects.toThrow("attempt budget");
	});

	test("Anthropic lane drill follows the fallback with zero in-gateway wait", async () => {
		const report = await runForcedFailoverDrill(anthropicDrill(1, 2_000));
		expect(report.ok).toBe(true);
		// fail fast: a 503 + Retry-After is never slept on nor replayed on the
		// same rung — the walk hops once, immediately, to the healthy fallback
		expect(report.simulatedWaitMs).toBe(0);
		expect(report.attempts.map((attempt) => attempt.group)).toEqual([
			"primary",
			"local",
		]);
	});

	test("a Retry-After beyond the drill wall budget still never sleeps", async () => {
		const report = await runForcedFailoverDrill(anthropicDrill(2, 1_000));
		expect(report.ok).toBe(true);
		expect(report.simulatedWaitMs).toBe(0);
	});

	function anthropicDrill(retryAfterS: number, maxWallMs: number) {
		return {
			policy: {
				num_retries: 1,
				request_timeout_s: 2,
				first_byte_budget_s: 4,
				retry_after_cap_s: 2,
				fallbacks: { primary: ["local"] },
			},
			pool: {
				groups: () => ["primary", "local"],
				deployments: (group: string) => [
					{
						group,
						url: `https://.example.invalid`,
						dialect: "anthropic" as const,
					},
				],
			},
			group: "primary",
			fallback: "local",
			failureStatus: 503 as const,
			dialect: "anthropic" as const,
			retryAfterS,
			maxAttempts: 4,
			maxWallMs,
		};
	}

	const sharedAccountPlan = {
		policy: {
			num_retries: 0,
			request_timeout_s: 1,
			first_byte_budget_s: 2,
			provider_pools: {
				shared: {
					concurrency: 1,
					intervalCap: 100,
					intervalMs: 50,
					maxOutstanding: 3,
					queueWaitMs: 1000,
					recovery: { successWindow: 8, decreasePercent: 5 },
				},
			},
			fallbacks: { primary: ["alias", "local"] },
		},
		pool: {
			groups: () => ["primary", "alias", "local"],
			deployments: (group: string) => [
				{
					group,
					url: `https://${group}.example.invalid`,
					dialect: "openai" as const,
					...(group === "local"
						? {}
						: { adapter_config: { provider_pool: "shared" } }),
				},
			],
		},
		group: "primary",
		failureStatus: 429 as const,
		maxAttempts: 3,
		maxWallMs: 2000,
	};

	// W1294.17 port delta: playwright has no test.each — the bun .each loop
	// became a for-of registration with the %d title interpolated per case.
	for (const retryAfterS of [1, 60])
		test(
			"account 429 Retry-After " +
				retryAfterS +
				"s skips same-account alias and reaches independent fallback without waiting",
			async () => {
				const started = performance.now();
				const report = await runForcedFailoverDrill({
					...sharedAccountPlan,
					retryAfterS,
					fallback: "local",
				});
				expect(performance.now() - started).toBeLessThan(300);
				expect(report.ok).toBe(true);
				expect(report.deliveredGroup).toBe("local");
				expect(report.attempts.map((a) => a.group)).toEqual([
					"primary",
					"local",
				]);
				expect(report.simulatedWaitMs).toBe(0);
			},
		);

	test("gate evidence: 429 Retry-After attributed verbatim, waits policy-capped, walk bounded", async () => {
		const report = await runForcedFailoverDrill({
			policy: {
				num_retries: 1,
				request_timeout_s: 2,
				retry_after_cap_s: 2,
				fallbacks: { primary: ["local"] },
			},
			pool: {
				groups: () => ["primary", "local"],
				deployments: (group) => [
					{ group, url: `https://${group}.example.invalid`, dialect: "openai" },
				],
			},
			group: "primary",
			fallback: "local",
			failureStatus: 429,
			retryAfterS: 30,
			maxAttempts: 4,
			maxWallMs: 2_000,
		});
		// Trace evidence: the 429's Retry-After lands on the failed attempt
		// VERBATIM (server-said), never silently dropped or rewritten.
		expect(report.attempts[0]).toMatchObject({
			group: "primary",
			status: 429,
			retryAfterMs: 30_000,
		});
		// The walk never WAITS on an account-pressure 429 — it skips to the
		// independent fallback (W1174); the 30s is attributed, not slept.
		expect(report.simulatedWaitMs).toBe(0);
		// No recursive gateway visit: the failed primary is visited once
		// (429 skips same-group retry), the fallback delivered once.
		const counts = new Map<string, number>();
		for (const a of report.attempts)
			counts.set(a.group, (counts.get(a.group) ?? 0) + 1);
		for (const n of counts.values()) expect(n).toBe(1);
		expect(report.deliveredGroup).toBe("local");
	});

	test("an all-same-account ladder truthfully cannot deliver through its blocked alias", async () => {
		const started = performance.now();
		const report = await runForcedFailoverDrill({
			...sharedAccountPlan,
			policy: {
				...sharedAccountPlan.policy,
				fallbacks: { primary: ["alias"] },
			},
			fallback: "alias",
		});
		expect(performance.now() - started).toBeLessThan(300);
		expect(report.ok).toBe(false);
		expect(report.deliveredGroup).toBeNull();
		expect(report.attempts.map((a) => a.status)).toEqual([429]);
		expect(report.simulatedWaitMs).toBe(0);
	});
});
