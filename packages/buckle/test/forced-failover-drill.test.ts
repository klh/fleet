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
