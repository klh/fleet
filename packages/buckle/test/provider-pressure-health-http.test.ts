import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cooldowns } from "../src/cooldown.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import { startServer } from "../src/server.ts";

async function chain(classified: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "pressure-health-"));
	let calls = 0;
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			if (req.method === "GET") {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 3500);
					req.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
				return new Response("unavailable", { status: 503 });
			}
			const order = ++calls;
			await Bun.sleep(order <= 6 ? 30 : 150);
			return order <= 6
				? Response.json(
						{
							error: {
								code: "1302",
								type: "rate_limit_error",
								message: classified
									? "synthetic concurrent occupancy pressure"
									: "synthetic occupancy pressure",
							},
						},
						{ status: 429 },
					)
				: Response.json({
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "recovered" },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					});
		},
	});
	const policy = (name: string, extra: Record<string, unknown>) => {
		const p = join(dir, `${name}.json`);
		writeFileSync(
			p,
			JSON.stringify({
				gateway: {
					num_retries: 0,
					allowed_fails: 3,
					cooldown_time: 30,
					...extra,
				},
			}),
		);
		return p;
	};
	const rows = (
		name: string,
		url: string,
		adapter_config: Record<string, unknown>,
	) => {
		const p = join(dir, `${name}-rows.json`);
		writeFileSync(
			p,
			JSON.stringify({
				inherit_defaults: false,
				groups: {
					fixture: [
						{
							url,
							dialect: "openai",
							api_key_env: "PRESSURE_HEALTH_FIXTURE_KEY",
							adapter_config,
						},
					],
				},
			}),
		);
		return p;
	};
	const oldKey = process.env.PRESSURE_HEALTH_FIXTURE_KEY;
	process.env.PRESSURE_HEALTH_FIXTURE_KEY = "fixture-pressure-root";
	const auth = { rootKey: "fixture-pressure-root" };
	const hub = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath: policy("hub", {}),
		upstreamsPath: rows(
			"hub",
			provider.url.href,
			classified ? { provider_concurrency_error_codes: ["1302"] } : {},
		),
		dbPath: ":memory:",
		auth,
	});
	const front = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath: policy("front", {
			allowed_fails: 99,
			provider_pools: {
				account: {
					concurrency: 50,
					intervalCap: 50,
					intervalMs: 50,
					maxOutstanding: 80,
					queueWaitMs: 2000,
					recovery: { successWindow: 8, decreasePercent: 5 },
					concurrencyErrorCodes: ["1302"],
				},
			},
		}),
		upstreamsPath: rows("front", `http://127.0.0.1:${hub.port}`, {
			provider_pool: "account",
		}),
		dbPath: ":memory:",
		auth,
	});
	const headers = {
		authorization: "Bearer fixture-pressure-root",
		"content-type": "application/json",
	};
	const send = async () => {
		const r = await fetch(
			`http://127.0.0.1:${front.port}/v1/chat/completions`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "fixture",
					messages: [{ role: "user", content: "fixture" }],
				}),
			},
		);
		return {
			status: r.status,
			retryAfter: r.headers.get("retry-after"),
			body: await r.json(),
		};
	};
	try {
		const burst = await Promise.all(Array.from({ length: 6 }, send));
		expect(burst.map((r) => r.status)).toEqual(Array(6).fill(429));
		expect(burst.every((r) => r.body.error.code === "1302")).toBe(true);
		const follow = await send();
		const slots = await (
			await fetch(`http://127.0.0.1:${front.port}/v1/admin/slots`, {
				headers,
			})
		).json();
		expect(
			Object.keys(
				(
					await (
						await fetch(`http://127.0.0.1:${hub.port}/v1/admin/slots`, {
							headers,
						})
					).json()
				).provider_pools,
			),
		).toHaveLength(0);
		return { follow, pool: slots.provider_pools.account, calls };
	} finally {
		front.stop(true);
		hub.stop(true);
		provider.stop(true);
		if (oldKey === undefined) delete process.env.PRESSURE_HEALTH_FIXTURE_KEY;
		else process.env.PRESSURE_HEALTH_FIXTURE_KEY = oldKey;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("two actual Buckle hops recover semantic output without inventory probing or synthetic occupancy cooldown", async () => {
	const before = await chain(false);
	// W1257: the follow-up arrives inside the hub's rate-limit cooldown —
	// it answers a typed LOCAL 503 hold (no_route story at the front), the
	// pool stays bounded by the provider's own Retry-After (~1s), and no
	// fabricated 429 masquerades as the provider
	expect(before.follow.status).toBe(503);
	expect(before.follow.body.error).toBeUndefined();
	expect(Number(before.follow.retryAfter ?? 0)).toBeLessThanOrEqual(30);
	expect(before.pool.adaptiveGapMs).toBe(2);
	expect(before.pool.notBeforeMs).toBeLessThan(Date.now() + 2000);
	expect(before.calls).toBe(6);
	const after = await chain(true);
	expect(after.follow.status).toBe(200);
	expect(after.follow.body.choices[0].message.content).toBe("recovered");
	expect(after.follow.retryAfter).toBeNull();
	expect(after.pool.adaptiveGapMs).toBe(1);
	expect(after.pool.notBeforeMs).toBe(0);
	expect(after.calls).toBe(7);
}, 10000);

test("deployment classification validates once and preserves unknown429 auth server and transport circuit protection", async () => {
	for (const mode of [
		"known",
		"concurrent",
		"unknown",
		"auth",
		"server",
		"network",
	] as const) {
		const dep = {
			group: "fixture",
			url: "https://fixture.invalid",
			dialect: "openai" as const,
			adapter_config: { provider_concurrency_error_codes: ["1302"] },
		};
		const cooldowns = new Cooldowns(1, 30);
		const router = new Router(parsePolicy("gateway: {num_retries: 0}"), {
			cooldowns,
			pool: { groups: () => ["fixture"], deployments: () => [dep] },
			fetchImpl: async () => {
				if (mode === "network") throw new Error("synthetic connect failure");
				return Response.json(
					{
						error: {
							code: mode === "unknown" ? "1113" : "1302",
							type: "rate_limit_error",
							...(mode === "concurrent"
								? { message: "too many concurrent requests, please retry" }
								: {}),
						},
					},
					{
						status: mode === "auth" ? 401 : mode === "server" ? 503 : 429,
						headers: { "retry-after": "2" },
					},
				);
			},
		});
		const result = await router.execute({
			group: "fixture",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "fixture" },
			key: "",
		});
		// W1257: only EXPLICIT provider concurrency evidence spares the bench
		// (account occupancy ≠ deployment health); a bare configured code is
		// rate pressure and benches like any throttle
		expect(cooldowns.benched(dep)).toBe(mode !== "concurrent");
		if (mode === "known" || mode === "concurrent") {
			expect(result.kind).toBe("client-error");
			if (result.kind === "client-error") {
				expect(result.response.status).toBe(429);
				expect(result.response.headers.get("retry-after")).toBe("2");
			}
		}
	}
	const bad = (codes: unknown) => () =>
		new Router(parsePolicy("gateway: {num_retries: 0}"), {
			pool: {
				groups: () => ["fixture"],
				deployments: () => [
					{
						group: "fixture",
						url: "https://fixture.invalid",
						dialect: "openai",
						adapter_config: { provider_concurrency_error_codes: codes },
					},
				],
			},
		});
	for (const codes of [["dup", "dup"], ["bad code"], [1], null])
		expect(bad(codes)).toThrow();
	expect(
		() =>
			new Router(
				parsePolicy(
					JSON.stringify({
						gateway: {
							provider_pools: {
								account: {
									concurrency: 1,
									intervalCap: 1,
									intervalMs: 1,
									maxOutstanding: 2,
									queueWaitMs: 100,
									recovery: { successWindow: 2, decreasePercent: 5 },
									concurrencyErrorCodes: ["pool-code"],
								},
							},
						},
					}),
				),
				{
					pool: {
						groups: () => ["fixture"],
						deployments: () => [
							{
								group: "fixture",
								url: "https://fixture.invalid",
								dialect: "openai",
								adapter_config: {
									provider_pool: "account",
									provider_concurrency_error_codes: ["different-code"],
								},
							},
						],
					},
				},
			),
	).toThrow("conflict");
});
