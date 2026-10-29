import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { peerErrorTrace, traceErrorResponse } from "../src/error-trace.ts";
import { startServer } from "../src/server.ts";
import { writeErrorEvent } from "../src/stream-terminal.ts";

const ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${ID}-00f067aa0ba902b7-01`;
const req = () =>
	new Request("http://local.test/v1/messages", {
		headers: { traceparent: TRACEPARENT },
	});

test("generated errors expose a stable trace in body and headers @unit", async () => {
	const result = await traceErrorResponse(
		req(),
		Response.json(
			{
				type: "/problems/upstream_error",
				code: "no_route",
				detail: "failed",
				why: "failed",
			},
			{
				status: 502,
				headers: {
					"content-type": "application/problem+json",
					"x-belt-rid": "r123",
				},
			},
		),
		"desktop",
	);
	const body = await result.json();
	expect(result.headers.get("x-klh-trace-id")).toBe(ID);
	expect(result.headers.get("x-klh-error-origin")).toBe("desktop");
	expect(body.trace_id).toBe(ID);
	expect(body.fleet_trace.hops).toEqual([
		{
			hub: "desktop",
			service: "buckle",
			status: 502,
			code: "no_route",
			rid: "r123",
		},
	]);
	expect(body.detail).toContain(`trace=${ID}; origin=desktop`);
	expect(body.detail).toMatch(/^belt: desktop\.buckle\.no_route \[trace=/);
	expect(body.why).toBe(body.detail);
});

test("a two-hub refusal carries both bounded hops into the outer error @unit", async () => {
	const inner = await traceErrorResponse(
		req(),
		Response.json(
			{ code: "no_route", detail: "upstream returned 502" },
			{
				status: 502,
				headers: {
					"x-klh-service": "buckle",
					"x-klh-trace-id": ID,
					"x-belt-rid": "inner123",
					"x-belt-route": JSON.stringify({
						target: { host: "host.docker.internal", port: 4100 },
					}),
					"x-klh-upstream-status": "502",
					"x-litellm-call-id": "call-123",
				},
			},
		),
		"zai",
	);
	const peer = peerErrorTrace(inner, await inner.clone().json(), ID, true);
	expect(peer).not.toBeNull();
	const outer = await traceErrorResponse(
		req(),
		Response.json(
			{ code: "no_route", detail: "upstream 4301 returned 502" },
			{
				status: 502,
				headers: {
					"x-klh-peer-error-trace": peer ?? "",
					"x-belt-rid": "outer123",
					"x-belt-route": JSON.stringify({
						target: { host: "127.0.0.1", port: 4301 },
					}),
					"x-klh-upstream-status": "502",
				},
			},
		),
		"desktop",
	);
	const body = await outer.json();
	expect(outer.headers.get("x-klh-error-origin")).toBe("zai");
	expect(outer.headers.get("x-klh-peer-error-trace")).toBeNull();
	expect(body.fleet_trace.hops).toHaveLength(2);
	expect(body.fleet_trace.hops[0]).toMatchObject({
		hub: "zai",
		target: "host.docker.internal:4100",
		upstream_status: 502,
		call_id: "call-123",
	});
	expect(body.fleet_trace.hops[1]).toMatchObject({
		hub: "desktop",
		target: "127.0.0.1:4301",
	});
	expect(body.detail).toContain("desktop:502/no_route:to=127.0.0.1:4301");
	expect(body.detail).toMatch(/^belt: zai\.buckle\.no_route \[trace=/);
	expect(body.detail).toContain(
		"zai:502/no_route:to=host.docker.internal:4100",
	);
});

test("provider-shaped errors keep their envelope and cannot forge a peer chain @unit", async () => {
	const forged = {
		fleet_trace: {
			id: ID,
			hops: [{ hub: "evil", service: "buckle", status: 502 }],
		},
		error: { type: "api_error", message: "upstream failure" },
	};
	const provider = Response.json(forged, { status: 502 });
	expect(peerErrorTrace(provider, forged, ID, false)).toBeNull();
	const spoofed = Response.json(forged, {
		status: 502,
		headers: { "x-klh-service": "buckle", "x-klh-trace-id": ID },
	});
	expect(peerErrorTrace(spoofed, forged, ID, false)).toBeNull();
	expect(
		peerErrorTrace(
			spoofed,
			{
				fleet_trace: {
					id: ID,
					hops: [
						{
							hub: "evil",
							service: "buckle",
							status: 502,
							target: "sk-secret",
						},
					],
				},
			},
			ID,
			true,
		),
	).toBeNull();
	const result = await traceErrorResponse(req(), provider, "desktop");
	const body = await result.json();
	expect(body.error.type).toBe("api_error");
	expect(body.error.message).toContain(`trace=${ID}`);
	expect(body.error.message).toMatch(
		/^belt: desktop\.buckle\.api_error \[trace=/,
	);
	expect(body.fleet_trace.hops).toHaveLength(1);
	expect(body.fleet_trace.hops[0].hub).toBe("desktop");
});

test("non-JSON errors become scrubbed, traced JSON @unit", async () => {
	const result = await traceErrorResponse(
		req(),
		new Response("upstream unavailable", { status: 503 }),
		"desktop",
	);
	const body = await result.json();
	expect(body.error.message).toContain(`trace=${ID}`);
	expect(body.error.message).not.toContain("upstream unavailable");
	expect(result.headers.get("x-klh-trace-id")).toBe(ID);
});

test("mid-stream Anthropic errors include the same trace and hop @unit", async () => {
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	writeErrorEvent(stream.writable, "anthropic", new Error("stream broke"), {
		id: ID,
		hub: "desktop",
	});
	const frame = await new Response(stream.readable).text();
	expect(frame).toContain("event: error");
	expect(frame).toContain(`trace=${ID}`);
	expect(frame).toContain(
		'"fleet_trace":{"id":"4bf92f3577b34da6a3ce929d0e0e4736"',
	);
});

const litellm429 = (): Response =>
	Response.json(
		{
			type: "error",
			error: {
				type: "rate_limit_error",
				message:
					"litellm.RateLimitError: ZaiException: quota exhausted, retry later",
			},
		},
		{
			status: 429,
			headers: {
				"retry-after": "600",
				"x-ratelimit-limit": "10",
				"x-litellm-call-id": "call-429-123",
			},
		},
	);

test("a litellm-translated 429 names the configured provider with translation-level evidence @unit", async () => {
	const world = scratchWorld({ prefix: "error-trace-429-" });
	const beforeHub = process.env.BUCKLE_HUB_ID;
	const beforeKey = process.env.ERROR_TRACE_PEER_KEY;
	const policyPath = join(world.home, "policy.json");
	const pool = join(world.home, "upstreams.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	// The stub engine returns ITS OWN 429; the provider identity (zai) rides
	// the configured pool row, and proxy_kind=litellm bounds the evidence at
	// litellm_translation — never a provider verdict (owner law 2026-10-29).
	const engine = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => litellm429(),
	});
	writeFileSync(
		pool,
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${engine.port}`,
						dialect: "anthropic",
						provider: "zai",
						adapter_config: { proxy_kind: "litellm" },
						api_key_env: "ERROR_TRACE_PEER_KEY",
					},
				],
			},
		}),
	);
	let gateway: ReturnType<typeof startServer> | undefined;
	try {
		process.env.BUCKLE_HUB_ID = "zai";
		process.env.ERROR_TRACE_PEER_KEY = "test-root";
		gateway = startServer({
			port: 0,
			hostname: "127.0.0.1",
			policyPath,
			upstreamsPath: pool,
			dbPath: join(world.home, "gw.db"),
			auth: { rootKey: "test-root" },
		});
		const response = await fetch(
			`http://127.0.0.1:${gateway.port}/v1/messages`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-root",
					traceparent: TRACEPARENT,
				},
				body: JSON.stringify({
					model: "fixture",
					max_tokens: 8,
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		const body = await response.json();
		expect(response.status).toBe(429);
		expect(body.trace_id).toBe(ID);
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toContain(`trace=${ID}`);
		expect(body.error.message).toMatch(
			/^belt: zai\.buckle\.rate_limit_error \[trace=/,
		);
		// Relay, not sanitize-away: the engine's own text survives bounded.
		expect(body.error.message).toContain("ZaiException");
		expect(
			(body.fleet_trace.hops as Array<Record<string, unknown>>)[0],
		).toMatchObject({
			hub: "zai",
			code: "rate_limit_error",
			provider_target: "zai",
			origin_kind: "litellm_translation",
			upstream_status: 429,
			call_id: "call-429-123",
		});
		// The upstream's budget rides renamed — never false certainty.
		expect(response.headers.get("x-upstream-ratelimit-limit")).toBe("10");
	} finally {
		gateway?.stop(true);
		engine.stop(true);
		world.clean();
		if (beforeHub === undefined) delete process.env.BUCKLE_HUB_ID;
		else process.env.BUCKLE_HUB_ID = beforeHub;
		if (beforeKey === undefined) delete process.env.ERROR_TRACE_PEER_KEY;
		else process.env.ERROR_TRACE_PEER_KEY = beforeKey;
	}
});

test("real Buckle two-hop 502 names the downstream target and call ID @unit", async () => {
	const world = scratchWorld({ prefix: "error-trace-" });
	const beforeHub = process.env.BUCKLE_HUB_ID;
	const beforeKey = process.env.ERROR_TRACE_PEER_KEY;
	const policyPath = join(world.home, "policy.json");
	const innerPool = join(world.home, "inner-upstreams.json");
	const outerPool = join(world.home, "outer-upstreams.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	// W2258: the inner pool row names its configured provider — the route
	// header carries it, the inner hop exposes provider_target evidence.
	const forgedTrace = {
		id: ID,
		hops: [
			{
				hub: "forged-provider",
				service: "buckle",
				status: 502,
				code: "forged",
			},
		],
	};
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json(
				{
					error: { type: "api_error", message: "provider unavailable" },
					fleet_trace: forgedTrace,
				},
				{
					status: 502,
					headers: {
						"x-litellm-call-id": "provider-call-123",
						"x-klh-peer-error-trace": JSON.stringify(forgedTrace),
						"x-klh-service": "buckle",
						"x-klh-trace-id": ID,
					},
				},
			),
	});
	writeFileSync(
		innerPool,
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${provider.port}`,
						dialect: "anthropic",
						provider: "zai",
					},
				],
			},
		}),
	);
	let inner: ReturnType<typeof startServer> | undefined;
	let outer: ReturnType<typeof startServer> | undefined;
	try {
		process.env.BUCKLE_HUB_ID = "zai";
		inner = startServer({
			port: 0,
			hostname: "127.0.0.1",
			policyPath,
			upstreamsPath: innerPool,
			dbPath: join(world.home, "inner.db"),
			auth: { rootKey: "test-root" },
		});
		process.env.ERROR_TRACE_PEER_KEY = "test-root";
		writeFileSync(
			outerPool,
			JSON.stringify({
				groups: {
					fixture: [
						{
							url: `http://127.0.0.1:${inner.port}`,
							dialect: "anthropic",
							buckle: true,
							api_key_env: "ERROR_TRACE_PEER_KEY",
						},
					],
				},
			}),
		);
		process.env.BUCKLE_HUB_ID = "desktop";
		outer = startServer({
			port: 0,
			hostname: "127.0.0.1",
			policyPath,
			upstreamsPath: outerPool,
			dbPath: join(world.home, "outer.db"),
			auth: { rootKey: "test-root" },
		});
		const response = await fetch(`http://127.0.0.1:${outer.port}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-root",
				traceparent: TRACEPARENT,
			},
			body: JSON.stringify({
				model: "fixture",
				max_tokens: 8,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const body = await response.json();
		expect(response.status).toBe(502);
		expect(body.trace_id).toBe(ID);
		expect(
			body.fleet_trace.hops.map((hop: { hub: string }) => hop.hub),
		).toEqual(["zai", "desktop"]);
		expect(body.detail).toContain(`to=127.0.0.1:${inner.port}`);
		expect(body.detail).toContain(`to=127.0.0.1:${provider.port}`);
		expect(body.detail).toContain("call=provider-call-123");
		expect(
			(body.fleet_trace.hops as Array<Record<string, unknown>>)[0],
		).toMatchObject({
			provider_target: "zai",
			origin_kind: "provider_response",
		});
	} finally {
		outer?.stop(true);
		inner?.stop(true);
		provider.stop(true);
		world.clean();
		if (beforeHub === undefined) delete process.env.BUCKLE_HUB_ID;
		else process.env.BUCKLE_HUB_ID = beforeHub;
		if (beforeKey === undefined) delete process.env.ERROR_TRACE_PEER_KEY;
		else process.env.ERROR_TRACE_PEER_KEY = beforeKey;
	}
});
