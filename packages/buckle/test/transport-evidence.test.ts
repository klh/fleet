import { expect, test } from "bun:test";
import {
	safeTransportEvidence,
	TransportObservation,
} from "../../telemetry/src/transport-evidence.ts";
import { createApp } from "../src/handlers.ts";
import { Ledger } from "../src/ledger.ts";
import { Router, type UpstreamRequest } from "../src/router.ts";
import { defaultFetch } from "../src/wire.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const traceId = "d".repeat(32);
const request = (signal?: AbortSignal): UpstreamRequest => ({
	group: "g",
	dialect: "openai",
	path: "/v1/chat/completions",
	body: {
		model: "g",
		messages: [{ role: "user", content: "synthetic private prompt" }],
		stream: true,
	},
	key: "synthetic-auth",
	signal,
	rid: "transport-request",
	trace: { traceparent: `00-${traceId}-${"e".repeat(16)}-01`, baggage: null },
});

test("actual preheader stall records local timeout/cancel with no invented provider acknowledgment", async () => {
	const upstream = await startMockUpstream(async () => {
		await Bun.sleep(200);
		return new Response("late");
	});
	const ledger = new Ledger(":memory:");
	const dep = { group: "g", url: upstream.url, dialect: "openai" as const };
	const router = new Router(
		{ num_retries: 0, request_timeout_s: 0.03 },
		{
			pool: { groups: () => ["g"], deployments: () => [dep] },
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt: (row) => ledger.auditAttempt(row),
			},
		},
	);
	try {
		const result = await router.execute(request());
		expect(result.kind).toBe("exhausted");
		const rows = ledger.traceAttempts(traceId);
		expect(rows).toHaveLength(1);
		expect(
			(rows[0]?.transport as { requestBodyBytes: number } | undefined)
				?.requestBodyBytes,
		).toBeGreaterThan(0);
		expect(rows[0]?.transport).toMatchObject({
			headersMs: null,
			firstBodyByteMs: null,
			bodyBytes: 0,
			bodyChunks: 0,
			timeoutPhase: "headers",
			cancellation: "local_settled",
			providerCancellationAcknowledged: null,
		});
		if (result.kind === "exhausted")
			expect(result.lastFailure?.transportTimeoutPhase).toBe("headers");
		expect(JSON.stringify(rows)).not.toContain("synthetic private prompt");
		expect(JSON.stringify(rows)).not.toContain("synthetic-auth");
	} finally {
		upstream.close();
		ledger.close();
	}
});

test("headers then stalled stream updates SAME durable attempt with bytes and idle phase", async () => {
	const upstream = await startMockUpstream(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: hello\n\n"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const ledger = new Ledger(":memory:");
	const dep = { group: "g", url: upstream.url, dialect: "openai" as const };
	const router = new Router(
		{ num_retries: 0, stream_idle_timeout_s: 0.03, stream_total_timeout_s: 1 },
		{
			pool: { groups: () => ["g"], deployments: () => [dep] },
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt: (row) => ledger.auditAttempt(row),
			},
		},
	);
	try {
		const result = await router.execute(request());
		expect(result.kind).toBe("upstream");
		if (result.kind !== "upstream") throw new Error("fixture routing failed");
		await expect(result.response.text()).rejects.toThrow("deadline");
		await Bun.sleep(5);
		const rows = ledger.traceAttempts(traceId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.transport).toMatchObject({
			bodyBytes: 13,
			bodyChunks: 1,
			timeoutPhase: "stream_idle",
			cancellation: "local_settled",
			providerCancellationAcknowledged: null,
		});
		expect(
			(rows[0]?.transport as { headersMs: number } | undefined)?.headersMs,
		).toBeGreaterThanOrEqual(0);
	} finally {
		upstream.close();
		ledger.close();
	}
});

test("actual downstream cancellation is local evidence, never a timeout or provider-stop claim", async () => {
	const upstream = await startMockUpstream(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([1, 2, 3]));
					},
				}),
			),
	);
	const transport = new TransportObservation();
	try {
		const response = await defaultFetch(
			{ group: "g", url: upstream.url, dialect: "openai" },
			{ ...request(), transport },
			1000,
			{ idleMs: 1000, totalMs: 2000 },
		);
		if (!response.body) throw new Error("fixture body missing");
		const reader = response.body.getReader();
		await reader.read();
		await reader.cancel();
		expect(transport.snapshot()).toMatchObject({
			bodyBytes: 3,
			bodyChunks: 1,
			timeoutPhase: null,
			cancellation: "local_settled",
			providerCancellationAcknowledged: null,
		});
	} finally {
		upstream.close();
	}
});

test("uninstrumented custom transport stays unknown and cannot inherit prior-attempt observations", async () => {
	const ledger = new Ledger(":memory:");
	const router = new Router(
		{ num_retries: 0 },
		{
			pool: {
				groups: () => ["g"],
				deployments: () => [
					{ group: "g", url: "https://example.invalid", dialect: "openai" },
				],
			},
			fetchImpl: async () => new Response("ok"),
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt: (row) => ledger.auditAttempt(row),
			},
		},
	);
	await router.execute(request());
	expect(ledger.traceAttempts(traceId)[0]?.transport).toBeNull();
	ledger.close();
});

test("transport validator projects only bounded observed fields and discards provider acknowledgments", () => {
	const observation = {
		requestBodyBytes: 20,
		headersMs: 0,
		firstBodyByteMs: null,
		timeoutBudgetMs: null,
		bodyBytes: 0,
		bodyChunks: 0,
		timeoutPhase: null,
		cancellation: null,
		providerCancellationAcknowledged: true,
		prompt: "private",
	};
	expect(safeTransportEvidence(observation)).toEqual({
		...observation,
		providerCancellationAcknowledged: null,
		prompt: undefined,
	});
	expect(
		safeTransportEvidence({ ...observation, bodyBytes: Infinity }),
	).toBeNull();
	expect(
		safeTransportEvidence({ ...observation, timeoutPhase: "provider_prefill" }),
	).toBeNull();
});

test("actual two-Buckle timeout phase crosses only an explicitly trusted peer", async () => {
	const provider = await startMockUpstream(async () => {
		await Bun.sleep(150);
		return new Response("late");
	});
	const pool = {
		groups: () => ["g"],
		deployments: () => [
			{ group: "g", url: provider.url, dialect: "openai" as const },
		],
	};
	const deps = testDeps(pool, {
		policy: { num_retries: 0, request_timeout_s: 0.02 },
	});
	const app = createApp(deps);
	const hub = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (r) =>
			new URL(r.url).pathname === "/status" ? new Response("ok") : app.fetch(r),
	});
	try {
		for (const trusted of [true, false]) {
			const router = new Router(
				{ num_retries: 0 },
				{
					pool: {
						groups: () => ["g"],
						deployments: () => [
							{
								group: "g",
								url: `http://127.0.0.1:${hub.port}`,
								dialect: "openai",
								buckle: trusted,
							},
						],
					},
				},
			);
			const result = await router.execute(request());
			expect(result.kind).toBe("exhausted");
			if (result.kind === "exhausted")
				expect(result.lastFailure?.transportTimeoutPhase).toBe(
					trusted ? "headers" : null,
				);
		}
	} finally {
		provider.close();
		hub.stop(true);
		deps.ledger.close();
	}
});

test("caller abort before headers records cancellation without timeout attribution", async () => {
	const upstream = await startMockUpstream(async () => {
		await Bun.sleep(150);
		return new Response("late");
	});
	const transport = new TransportObservation(),
		controller = new AbortController();
	try {
		const pending = defaultFetch(
			{ group: "g", url: upstream.url, dialect: "openai" },
			{ ...request(controller.signal), transport },
			1000,
		);
		await Bun.sleep(10);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(transport.snapshot()).toMatchObject({
			headersMs: null,
			timeoutPhase: null,
			cancellation: "local_settled",
			providerCancellationAcknowledged: null,
		});
	} finally {
		upstream.close();
	}
});

test("healthy body chunks cannot reset stream total deadline", async () => {
	const upstream = await startMockUpstream(
		() =>
			new Response(
				new ReadableStream({
					async start(c) {
						try {
							for (let i = 0; i < 20; i++) {
								c.enqueue(new Uint8Array([1]));
								await Bun.sleep(5);
							}
							c.close();
						} catch {
							/* disconnected fixture */
						}
					},
				}),
			),
	);
	const transport = new TransportObservation();
	try {
		const response = await defaultFetch(
			{ group: "g", url: upstream.url, dialect: "openai" },
			{ ...request(), transport },
			1000,
			{ idleMs: 100, totalMs: 30 },
		);
		await expect(response.text()).rejects.toThrow("deadline");
		await Bun.sleep(2);
		expect(transport.snapshot()).toMatchObject({
			timeoutPhase: "stream_total",
			cancellation: "local_settled",
			providerCancellationAcknowledged: null,
		});
		expect(transport.snapshot()?.bodyBytes).toBeGreaterThan(1);
	} finally {
		upstream.close();
	}
});
