import { expect, test } from "@playwright/test";
import { Router, UpstreamError } from "../src/router.ts";

test.describe({ tag: "@unit" }, () => {
	const pool = {
		groups: () => ["primary", "fallback", "last"],
		deployments: (group: string) => [
			{
				group,
				url: `https://${group}.example.invalid`,
				dialect: "anthropic" as const,
			},
		],
	};

	const request = (signal?: AbortSignal) => ({
		group: "primary",
		dialect: "anthropic" as const,
		path: "/v1/messages",
		body: {
			model: "primary",
			max_tokens: 16,
			messages: [{ role: "user", content: "test" }],
		},
		key: "",
		signal,
	});

	test("slow primary keeps its full allowance and fallbacks share the remaining first-byte budget", async () => {
		let now = 0;
		const seen: Array<{ group: string; timeoutMs: number }> = [];
		const router = new Router(
			{
				request_timeout_s: 120,
				first_byte_budget_s: 240,
				num_retries: 1,
				fallbacks: { primary: ["fallback", "last"] },
			},
			{
				pool,
				now: () => now,
				fetchImpl: async (dep, _req, timeoutMs) => {
					seen.push({ group: dep.group, timeoutMs });
					now += timeoutMs;
					throw new UpstreamError(502, "synthetic first-byte timeout");
				},
			},
		);
		const result = await router.execute(request());
		expect(seen).toEqual([
			{ group: "primary", timeoutMs: 120_000 },
			{ group: "fallback", timeoutMs: 120_000 },
		]);
		expect(result.kind).toBe("exhausted");
		if (result.kind === "exhausted") {
			expect(result.status).toBe(504);
			expect(result.lastFailure?.kind).toBe("walk_deadline");
		}
	});

	test("a fallback receives its bounded remainder and can deliver an Anthropic response", async () => {
		let now = 0;
		const seen: number[] = [];
		const router = new Router(
			{
				request_timeout_s: 120,
				first_byte_budget_s: 150,
				num_retries: 0,
				fallbacks: { primary: ["fallback"] },
			},
			{
				pool,
				now: () => now,
				fetchImpl: async (dep, _req, timeoutMs) => {
					seen.push(timeoutMs);
					if (dep.group === "primary") {
						now += 120_000;
						throw new UpstreamError(502, "synthetic first-byte timeout");
					}
					return Response.json({
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
					});
				},
			},
		);
		const result = await router.execute(request());
		expect(seen).toEqual([120_000, 30_000]);
		expect(result.kind).toBe("upstream");
		if (result.kind === "upstream") expect(result.tier).toBe("fallback");
	});

	test("caller cancellation interrupts a same-candidate Retry-After wait", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const router = new Router(
			{
				request_timeout_s: 2,
				first_byte_budget_s: 4,
				num_retries: 1,
				retry_after_cap_s: 2,
			},
			{
				pool,
				fetchImpl: async () => {
					attempts++;
					return Response.json(
						{ error: { message: "busy" } },
						{ status: 503, headers: { "retry-after": "1" } },
					);
				},
			},
		);
		const started = Date.now();
		const pending = router.execute(request(controller.signal));
		setTimeout(() => controller.abort(), 10);
		expect((await pending).kind).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(500);
		expect(attempts).toBe(1);
	});

	test("first-byte deadline ends when streaming headers arrive", async () => {
		let now = 0;
		const router = new Router(
			{ request_timeout_s: 2, first_byte_budget_s: 3 },
			{
				pool,
				now: () => now,
				fetchImpl: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("data: first\n\n"));
								setTimeout(
									() =>
										controller.enqueue(
											new TextEncoder().encode("data: second\n\n"),
										),
									10,
								);
								setTimeout(() => controller.close(), 20);
							},
						}),
					),
			},
		);
		const result = await router.execute({
			...request(),
			body: { ...request().body, stream: true },
		});
		expect(result.kind).toBe("upstream");
		now = 4_000;
		if (result.kind === "upstream")
			expect(await result.response.text()).toContain("second");
	});

	test("streamed timeout skips another LiteLLM model row on the same configured origin", async () => {
		let now = 0;
		const seen: Array<{ url: string; timeoutMs: number }> = [];
		const router = new Router(
			{
				request_timeout_s: 120,
				first_byte_budget_s: 240,
				num_retries: 1,
				fallbacks: { primary: ["fallback"] },
			},
			{
				pool: {
					groups: () => ["primary", "fallback"],
					deployments: (group) =>
						group === "primary"
							? [
									{
										group,
										url: "https://engine.example.invalid/one",
										dialect: "anthropic",
									},
									{
										group,
										url: "https://engine.example.invalid/two",
										dialect: "anthropic",
									},
								]
							: [
									{
										group,
										url: "https://local.example.invalid",
										dialect: "anthropic",
									},
								],
				},
				now: () => now,
				fetchImpl: async (dep, _req, timeoutMs) => {
					seen.push({ url: dep.url, timeoutMs });
					if (dep.group === "primary") {
						now += timeoutMs;
						throw new DOMException("synthetic timeout", "TimeoutError");
					}
					return Response.json({
						type: "message",
						role: "assistant",
						content: [],
					});
				},
			},
		);
		const result = await router.execute({
			...request(),
			body: { ...request().body, stream: true },
		});
		expect(result.kind).toBe("upstream");
		if (result.kind === "upstream") expect(result.tier).toBe("fallback");
		expect(seen).toEqual([
			{ url: "https://engine.example.invalid/one", timeoutMs: 120_000 },
			{ url: "https://local.example.invalid", timeoutMs: 120_000 },
		]);
	});

	test("headers received exactly at the walk deadline still deliver the successful response", async () => {
		let now = 0;
		const router = new Router(
			{ request_timeout_s: 2, first_byte_budget_s: 2 },
			{
				pool,
				now: () => now,
				fetchImpl: async () => {
					now = 2_000;
					return Response.json({
						type: "message",
						role: "assistant",
						content: [],
					});
				},
			},
		);
		const result = await router.execute(request());
		expect(result.kind).toBe("upstream");
	});
});
