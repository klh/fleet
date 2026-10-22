import { expect, test } from "bun:test";
import { runForcedFailoverDrill } from "../src/forced-failover-drill.ts";

test.each([429, 503])(
	"forced %d failover is bounded and attributes the failed layer",
	async (status) => {
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
					{ group, url: `https://${group}.example.invalid`, dialect: "openai" },
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
	},
);

test("drill rejects a retrying policy that would exceed its attempt budget", async () => {
	await expect(
		runForcedFailoverDrill({
			policy: { num_retries: 1, fallbacks: { primary: ["local"] } },
			pool: {
				groups: () => ["primary", "local"],
				deployments: (group) => [
					{ group, url: `https://${group}.example.invalid`, dialect: "openai" },
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

test("Anthropic lane drill follows the fallback and accounts for virtual retry wait", async () => {
	const report = await runForcedFailoverDrill({
		policy: {
			num_retries: 1,
			request_timeout_s: 2,
			first_byte_budget_s: 4,
			retry_after_cap_s: 2,
			fallbacks: { primary: ["local"] },
		},
		pool: {
			groups: () => ["primary", "local"],
			deployments: (group) => [
				{
					group,
					url: `https://${group}.example.invalid`,
					dialect: "anthropic",
				},
			],
		},
		group: "primary",
		fallback: "local",
		failureStatus: 503,
		dialect: "anthropic",
		retryAfterS: 1,
		maxAttempts: 4,
		maxWallMs: 2_000,
	});
	expect(report.ok).toBe(true);
	expect(report.simulatedWaitMs).toBe(1_000);
	expect(report.attempts.map((attempt) => attempt.group)).toEqual([
		"primary",
		"primary",
		"local",
	]);
});

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

test.each([1, 60])(
	"account 429 Retry-After %ds skips same-account alias and reaches independent fallback without waiting",
	async (retryAfterS) => {
		const started = performance.now();
		const report = await runForcedFailoverDrill({
			...sharedAccountPlan,
			retryAfterS,
			fallback: "local",
		});
		expect(performance.now() - started).toBeLessThan(300);
		expect(report.ok).toBe(true);
		expect(report.deliveredGroup).toBe("local");
		expect(report.attempts.map((a) => a.group)).toEqual(["primary", "local"]);
		expect(report.simulatedWaitMs).toBe(0);
	},
);

test("an all-same-account ladder truthfully cannot deliver through its blocked alias", async () => {
	const started = performance.now();
	const report = await runForcedFailoverDrill({
		...sharedAccountPlan,
		policy: { ...sharedAccountPlan.policy, fallbacks: { primary: ["alias"] } },
		fallback: "alias",
	});
	expect(performance.now() - started).toBeLessThan(300);
	expect(report.ok).toBe(false);
	expect(report.deliveredGroup).toBeNull();
	expect(report.attempts.map((a) => a.status)).toEqual([429]);
	expect(report.simulatedWaitMs).toBe(0);
});
