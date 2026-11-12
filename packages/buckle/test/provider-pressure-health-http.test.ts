import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cooldowns } from "../src/cooldown.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import { startServer } from "../src/server.ts";

async function chain(classified: boolean, gapMs = 0, recoverAfter = 6) {
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
			await Bun.sleep(order <= recoverAfter ? 30 : 150);
			return order <= recoverAfter
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
		// W2585/W2617 single-flight: the first knock claims the cold-start
		// probe (the real provider rung) and the herd rides — a wave is
		// RELAYED (429 + provider envelope code 1302) plus honest LOCAL
		// rider refusals (problem body, never a fabricated envelope, W1257)
		const relayed = burst.filter((r) => r.body.error !== undefined);
		const local = burst.filter((r) => r.body.error === undefined);
		expect(relayed.length).toBeGreaterThan(0);
		for (const r of relayed) {
			expect(r.status).toBe(429);
			expect(r.body.error.code).toBe("1302");
		}
		expect(local.every((r) => [429, 502, 503].includes(r.status))).toBe(true);
		for (const r of local) {
			// front-local pool refusal, typed no_route, or the shared cold
			// mark — honest LOCAL stories only, never a fabricated envelope
			expect(r.body.detail).toMatch(/provider account pool|no_route|cold mark/);
		}
		// wait out the fixture's unclamped rate cold (no Retry-After → the
		// 5s default window, +20% jitter): the recovery follow-up must
		// arrive OUTSIDE the window, through the half-open probe
		if (gapMs > 0) await Bun.sleep(gapMs);
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
	// The follow-up arrives inside the shared cold window — no in-flight
	// verdict gate to ride, so the walk skips the cold rung and answers the
	// typed LOCAL no_healthy_fit 503 + Retry-After (problem body: no
	// provider envelope is fabricated, W1257; the riding herd's 429 holds
	// are the burst shape above), the pool stays bounded, and the
	// outermost client owns the retry
	expect(before.follow.status).toBe(503);
	expect(before.follow.body.error).toBeUndefined();
	expect(Number(before.follow.retryAfter ?? 0)).toBeLessThanOrEqual(30);
	expect(before.pool.adaptiveGapMs).toBe(2);
	expect(before.pool.notBeforeMs).toBeLessThan(Date.now() + 2000);
	// W2585/W2617 single-flight: of the 6-client burst exactly ONE knock
	// reaches the provider; the herd rides the verdict and answers locally
	expect(before.calls).toBe(1);
	const after = await chain(true, 6500, 1);
	expect(after.follow.status).toBe(200);
	expect(after.follow.body.choices[0].message.content).toBe("recovered");
	expect(after.follow.retryAfter).toBeNull();
	// recovery never leaves the pool pacing worse than the refused state
	// (exact AIMD arithmetic is run-to-run — the one-knock burst counts one
	// epoch where the 6-forward design counted six)
	expect(after.pool.adaptiveGapMs).toBeLessThanOrEqual(
		before.pool.adaptiveGapMs,
	);
	// the snapshot's notBefore is an ABSOLUTE epoch stamp when adaptive
	// pacing is on (lastStartedAt + gap ≤ now + gapCeiling; the ceiling is
	// min(queueWaitMs/4=500, …) in this chain) — never a fabricated 0
	expect(after.pool.notBeforeMs).toBeLessThanOrEqual(Date.now() + 600);
	// one burst knock + the follow's half-open probe knock — the herd
	// answered locally again (single-flight)
	expect(after.calls).toBe(2);
}, 25_000); // two honest chains: each follow rides the half-open probe's bounded cold wait

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
		// W1253-A: routing policy is JSON (the yaml format is retired)
		const router = new Router(
			parsePolicy(JSON.stringify({ gateway: { num_retries: 0 } })),
			{
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
			},
		);
		const result = await router.execute({
			group: "fixture",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "fixture" },
			key: "",
		});
		// Every refusal holds the rung (benched = shared cold ∪ ejection);
		// the AXIS differs: rate/quota refusals (any pressure word) cold the
		// shared account mark but NEVER count the consecutive-failure
		// ejection — account occupancy ≠ deployment health (W1257, AIMD owns
		// the occupancy axis); only auth/server/network eject (allowed_fails 1)
		const rateMode =
			mode === "known" || mode === "concurrent" || mode === "unknown";
		expect(cooldowns.benched(dep)).toBe(true);
		expect(cooldowns.ejected(dep)).toBe(!rateMode);
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
