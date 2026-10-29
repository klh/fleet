import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";

const GROUP = "openai-only-model";

function poolOf(deployments: Array<Omit<Deployment, "group">>): UpstreamPool {
	return {
		groups: () => [GROUP],
		deployments: (group) =>
			group === GROUP ? deployments.map((dep) => ({ ...dep, group })) : [],
	};
}

function countRequest(): Request {
	return new Request("http://127.0.0.1:4101/v1/messages/count_tokens", {
		method: "POST",
		body: JSON.stringify({
			model: GROUP,
			system: "Be concise",
			messages: [{ role: "user", content: "How many tokens?" }],
		}),
	});
}

test.describe("count_tokens capability fallback @api", () => {
	test("OpenAI-only group returns an explicitly estimated count without upstream traffic", async () => {
		const stub = serveStub(
			() => new Response("unexpected upstream call", { status: 500 }),
		);
		try {
			const deps = testDeps(poolOf([{ url: stub.url, dialect: "openai" }]));
			const response = await createApp(deps).fetch(countRequest());
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				input_tokens: expect.any(Number),
			});
			expect(response.headers.get("x-klh-token-count-method")).toBe(
				"estimated-bytes-v1",
			);
			expect(stub.requests).toHaveLength(0);
		} finally {
			stub.close();
		}
	});

	test("native Anthropic count capability remains an upstream call", async () => {
		const stub = serveStub(() => Response.json({ input_tokens: 23 }));
		const openai = serveStub(
			() => new Response("unsupported", { status: 404 }),
		);
		try {
			const deps = testDeps(
				poolOf([
					{ url: openai.url, dialect: "openai" },
					{ url: stub.url, dialect: "anthropic" },
				]),
			);
			const response = await createApp(deps).fetch(countRequest());
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ input_tokens: 23 });
			expect(response.headers.get("x-klh-token-count-method")).toBeNull();
			expect(stub.requests.map((req) => req.path)).toEqual([
				"/v1/messages/count_tokens",
			]);
			expect(openai.requests).toHaveLength(0);
		} finally {
			stub.close();
			openai.close();
		}
	});

	test("unconfigured groups still refuse instead of fabricating a count", async () => {
		const deps = testDeps(poolOf([]));
		const response = await createApp(deps).fetch(countRequest());
		expect(response.status).toBe(503);
		expect(response.headers.get("x-klh-token-count-method")).toBeNull();
	});

	test("malformed count requests are rejected before an estimate or upstream call", async () => {
		const stub = serveStub(
			() => new Response("unexpected upstream call", { status: 500 }),
		);
		try {
			const deps = testDeps(poolOf([{ url: stub.url, dialect: "openai" }]));
			const response = await createApp(deps).fetch(
				new Request("http://127.0.0.1:4101/v1/messages/count_tokens", {
					method: "POST",
					body: JSON.stringify({ model: GROUP, messages: "not-an-array" }),
				}),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("x-klh-token-count-method")).toBeNull();
			expect(stub.requests).toHaveLength(0);
		} finally {
			stub.close();
		}
	});
});
