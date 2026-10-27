import { expect, test } from "bun:test";
import {
	normalizeUpstreamError,
	routerErrorEnvelope,
} from "../src/adapters/errors.ts";
import { createApp } from "../src/handlers.ts";
import { Router } from "../src/router.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const limited = () =>
	Response.json(
		{
			type: "error",
			error: {
				type: "rate_limit_error",
				code: "1302",
				message: "Rate limit reached for requests",
			},
		},
		{ status: 429, headers: { "retry-after": "7" } },
	);

for (const fallback of [400, 503, "network"] as const) {
	test(`primary rate limit survives fallback ${fallback}`, async () => {
		const router = new Router(
			{ num_retries: 0, fallbacks: { primary: ["fallback"] } },
			{
				pool: {
					groups: () => ["primary", "fallback"],
					deployments: (group) => [
						{ group, url: `http://${group}`, dialect: "anthropic" },
					],
				},
				sleepMs: async () => {},
				fetchImpl: async (dep) => {
					if (dep.group === "primary") return limited();
					if (fallback === "network") throw new Error("connection refused");
					return Response.json(
						{ error: { message: "fallback failure" } },
						{ status: fallback },
					);
				},
			},
		);
		const result = await router.execute({
			group: "primary",
			dialect: "anthropic",
			path: "/v1/messages",
			body: { model: "primary" },
			key: "",
		});
		expect(result.kind).toBe("client-error");
		if (result.kind !== "client-error") throw new Error("rate limit lost");
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get("retry-after")).toBe("7");
		expect((await result.response.json()).error).toMatchObject({
			type: "rate_limit_error",
			code: "1302",
		});
	});
}

for (const stream of [false, true]) {
	test(`actual Anthropic handler returns HTTP429 before stream=${stream} headers`, async () => {
		const upstream = await startMockUpstream(limited);
		try {
			const pool = {
				groups: () => ["glm-5.3-flash"],
				deployments: (group: string) => [
					{ group, url: upstream.url, dialect: "anthropic" as const },
				],
			};
			const deps = testDeps(pool, {
				policy: { num_retries: 0 },
				sleepMs: async () => {},
			});
			const response = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "glm-5.3-flash", stream }),
				}),
			);
			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("7");
			expect(await response.json()).toMatchObject({
				type: "error",
				error: {
					type: "rate_limit_error",
					code: "1302",
				},
			});
			const audit = deps.ledger.auditRows()[0];
			expect(audit).toMatchObject({
				status: 429,
				ok: 0,
				decision: "errored",
				error_code: "rate_limited",
				err: "rate_limited",
			});
			expect(response.headers.get("x-belt-error")).toBe("rate_limited");
		} finally {
			upstream.close();
		}
	});
}

test("handler relays a cooled provider throttle as 429; W1077 probe grants one recovery attempt", async () => {
	let calls = 0;
	const upstream = await startMockUpstream(() => {
		calls++;
		return limited();
	});
	try {
		const group = "glm-5.3-flash";
		const deps = testDeps(
			{
				groups: () => [group],
				deployments: () => [
					{ group, url: upstream.url, dialect: "anthropic" as const },
				],
			},
			{ policy: { num_retries: 0, allowed_fails: 1, cooldown_time: 30 } },
		);
		const app = createApp(deps);
		const request = () =>
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({ model: group, max_tokens: 8, messages: [] }),
			});
		expect((await app.fetch(request())).status).toBe(429);
		const cooled = await app.fetch(request());
		expect(cooled.status).toBe(429);
		expect(Number(cooled.headers.get("retry-after"))).toBeGreaterThan(0);
		// W1077: the benched leg gets ONE liveness probe + one recovery
		// attempt per request (still 429, still relayed verbatim); the probe
		// GET also reaches the mock upstream, so calls = r1-attempt + r2-probe
		// + r2-attempt = 3.
		expect(calls).toBe(3);
		expect(deps.ledger.auditRows().map((r) => r.status)).toEqual([429, 429]);
	} finally {
		upstream.close();
	}
});

test("auth and generic server errors remain distinct; SSE envelopes retain rate-limit code", () => {
	for (const status of [401, 500]) {
		const error = normalizeUpstreamError("anthropic", status, {
			error: { type: "api_error", code: "1302" },
		});
		expect(error.kind).toBe(status === 401 ? "auth" : "server");
	}
	const error = normalizeUpstreamError("anthropic", 429, {
		error: { type: "api_error", code: "1302" },
	});
	expect(routerErrorEnvelope(error, "anthropic")).toMatchObject({
		type: "error",
		error: {
			type: "rate_limit_error",
			code: "1302",
		},
	});
});

test("already committed Anthropic SSE preserves the provider rate-limit event", async () => {
	const frame =
		'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","code":"1302","message":"Rate limit reached"}}\n\n';
	const upstream = await startMockUpstream(
		() =>
			new Response(frame, { headers: { "content-type": "text/event-stream" } }),
	);
	try {
		const pool = {
			groups: () => ["glm-5.3-flash"],
			deployments: (group: string) => [
				{ group, url: upstream.url, dialect: "anthropic" as const },
			],
		};
		const response = await createApp(testDeps(pool)).fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({ model: "glm-5.3-flash", stream: true }),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(frame);
	} finally {
		upstream.close();
	}
});

test("retry jitter grows with attempts but never delays the next fallback rung", async () => {
	const slept: number[] = [];
	const router = new Router(
		{
			num_retries: 1,
			retry_max_delay_s: 8,
			fallbacks: { primary: ["fallback"] },
		},
		{
			pool: {
				groups: () => ["primary", "fallback"],
				deployments: (group) => [
					{ group, url: `http://${group}`, dialect: "anthropic" },
				],
			},
			rng: () => 0.25,
			sleepMs: async (ms) => {
				slept.push(ms);
			},
			fetchImpl: async () =>
				Response.json(
					{ error: { message: "limited" } },
					{ status: 429, headers: { "retry-after": "0" } },
				),
		},
	);
	await router.execute({
		group: "primary",
		dialect: "anthropic",
		path: "/v1/messages",
		body: {},
		key: "",
	});
	expect(slept).toEqual([1250, 4250]); // One retry per candidate; no cross-rung sleep.
});

test("quota-wall retry-after (W695.6.1): floor capped, 429 + retry-after still relayed", async () => {
	const slept: number[] = [];
	const router = new Router(
		{ num_retries: 1, retry_after_cap_s: 60 },
		{
			pool: {
				groups: () => ["primary"],
				deployments: (group) => [
					{ group, url: `http://${group}`, dialect: "anthropic" },
				],
			},
			rng: () => 0,
			sleepMs: async (ms) => {
				slept.push(ms);
			},
			fetchImpl: async () =>
				Response.json(
					{
						type: "error",
						error: {
							type: "rate_limit_error",
							code: "1302",
							message: "quota exhausted",
						},
					},
					{ status: 429, headers: { "retry-after": "1670111" } },
				),
		},
	);
	const result = await router.execute({
		group: "primary",
		dialect: "anthropic",
		path: "/v1/messages",
		body: {},
		key: "",
	});
	expect(slept).toEqual([]); // Quota wall advances without a long sleep.
	expect(result.kind).toBe("client-error");
	if (result.kind !== "client-error") throw new Error("rate limit lost");
	expect(result.response.status).toBe(429);
	// W1303.2: the weeks-long provider retry-after (1670111s) relays
	// CLAMPED to the 300s emission cap (http-kit clampRetryAfter) — the
	// W695.6.1 verbatim relay was the sleeps-clients-for-weeks bug.
	expect(result.response.headers.get("retry-after")).toBe("300");
});
