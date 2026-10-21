import { expect, test } from "bun:test";
import { problem } from "../src/citizenship.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function request(model: string): Request {
	return new Request("http://buckle.test/v1/messages", {
		method: "POST",
		headers: { traceparent: TRACE },
		body: JSON.stringify({
			model,
			max_tokens: 8,
			messages: [{ role: "user", content: "hi" }],
		}),
	});
}

function pool(
	group: string,
	url: string,
	dialect: "anthropic" | "openai",
): UpstreamPool {
	return {
		groups: () => [group],
		deployments: (name) => (name === group ? [{ group, url, dialect }] : []),
	};
}

function expectCorrelation(response: Response): void {
	expect(response.headers.get("x-klh-service")).toBe("buckle");
	expect(response.headers.get("x-klh-trace-id")).toBe(
		TRACE.split("-")[1] ?? "",
	);
	expect(response.headers.get("x-belt-rid")).toMatch(/^r/);
	expect(response.headers.get("x-klh-attempts")).not.toBeNull();
}

test("generated local refusal says buckle and carries no upstream status", async () => {
	const response = problem({
		status: 429,
		code: "buckle.overloaded",
		why: "local cap",
	});
	expect(response.headers.get("x-klh-service")).toBe("buckle");
	expect(response.headers.get("x-klh-refusal")).toBe("buckle");
	expect(response.headers.get("x-klh-upstream-status")).toBeNull();
});

test("upstream 429 is distinguished from a local throttle", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json(
			{
				error: {
					type: "rate_limit_error",
					message: "limited",
					request_id: "req_429",
				},
			},
			{
				status: 429,
				headers: { "retry-after": "7", "x-litellm-call-id": "call-429" },
			},
		),
	);
	try {
		const deps = testDeps(pool("model-a", upstream.url, "anthropic"), {
			policy: { num_retries: 0 },
		});
		const response = await createApp(deps).fetch(request("model-a"));
		expect(response.status).toBe(429);
		expectCorrelation(response);
		expect(response.headers.get("x-klh-refusal")).toBe("upstream");
		expect(response.headers.get("x-klh-upstream-status")).toBe("429");
		expect(response.headers.get("x-klh-upstream-kind")).toBe("rate_limited");
		expect(response.headers.get("retry-after")).toBe("7");
		expect(response.headers.get("x-klh-upstream-request-id")).toBe("req_429");
		expect(response.headers.get("x-litellm-call-id")).toBe("call-429");
		expect(deps.sm.expose()).toContain("buckle_refusals_total");
		expect(deps.sm.expose()).toContain('source="upstream"');
	} finally {
		upstream.close();
	}
});

test("exhausted 503 preserves bounded retry and upstream trace attribution", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json(
			{ error: { type: "overloaded_error", message: "warming" } },
			{
				status: 503,
				headers: { "retry-after": "60", "x-request-id": "req_cold" },
			},
		),
	);
	try {
		const response = await createApp(
			testDeps(pool("model-cold", upstream.url, "anthropic"), {
				policy: { num_retries: 0, retry_after_cap_s: 2 },
			}),
		).fetch(request("model-cold"));
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("2");
		expectCorrelation(response);
		expect(response.headers.get("x-klh-refusal")).toBe("upstream");
		expect(response.headers.get("x-klh-upstream-status")).toBe("503");
		expect(response.headers.get("x-klh-upstream-request-id")).toBe("req_cold");
	} finally {
		upstream.close();
	}
});

test("a bridged upstream 400 remains attributable after ladder exhaustion", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json(
			{ error: { message: "unsupported field" } },
			{
				status: 400,
				headers: {
					"x-request-id": "req_400",
					"x-litellm-call-id": "call-400",
				},
			},
		),
	);
	try {
		const response = await createApp(
			testDeps(pool("model-b", upstream.url, "openai"), {
				policy: { num_retries: 0 },
			}),
		).fetch(request("model-b"));
		expect(response.status).toBe(502);
		expectCorrelation(response);
		expect(response.headers.get("x-klh-refusal")).toBe("bridged-upstream");
		expect(response.headers.get("x-klh-upstream-status")).toBe("400");
		expect(response.headers.get("x-klh-upstream-kind")).toBe("bad_request");
		expect(response.headers.get("x-belt-error")).toBe("no_route");
		expect(response.headers.get("x-klh-upstream-request-id")).toBe("req_400");
		expect(response.headers.get("x-litellm-call-id")).toBe("call-400");
	} finally {
		upstream.close();
	}
});

test("provider-controlled correlation headers cannot inject arbitrary text", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json(
			{ error: { message: "bad", request_id: "prompt words and spaces" } },
			{
				status: 400,
				headers: {
					"x-litellm-call-id": "bad/value",
					"x-litellm-model-api-base":
						"https://internal.example.invalid/path?key=private",
				},
			},
		),
	);
	try {
		const response = await createApp(
			testDeps(pool("model-c", upstream.url, "openai"), {
				policy: { num_retries: 0 },
			}),
		).fetch(request("model-c"));
		expect(response.headers.get("x-klh-upstream-request-id")).toBeNull();
		expect(response.headers.get("x-litellm-call-id")).toBeNull();
		expect(response.headers.get("x-litellm-model-api-base")).toBeNull();
	} finally {
		upstream.close();
	}
});

test("no configured route is a Buckle refusal with zero attempts", async () => {
	const empty: UpstreamPool = { groups: () => [], deployments: () => [] };
	const response = await createApp(testDeps(empty)).fetch(request("missing"));
	expect(response.status).toBe(503);
	expectCorrelation(response);
	expect(response.headers.get("x-klh-refusal")).toBe("buckle");
	expect(response.headers.get("x-klh-attempts")).toBe("0");
	expect(response.headers.get("x-klh-upstream-status")).toBeNull();
});

test("unreachable hop is network provenance without a fabricated upstream HTTP status", async () => {
	const deps = testDeps(pool("offline", "http://127.0.0.1:1", "anthropic"), {
		policy: { num_retries: 0 },
	});
	const response = await createApp(deps).fetch(request("offline"));
	expect(response.status).toBe(502);
	expectCorrelation(response);
	expect(response.headers.get("x-klh-refusal")).toBe("network");
	expect(response.headers.get("x-klh-upstream-kind")).toBe("network");
	expect(response.headers.get("x-klh-upstream-status")).toBeNull();
});
