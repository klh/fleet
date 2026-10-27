import { expect, test } from "@playwright/test";
import { createModelProxy } from "../bin/model-proxy.ts";

const calls: {
	path: string;
	authorization: string | null;
	traceparent: string | null;
}[] = [];
let models = ["qwen2.5:0.5b"];
const upstream = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		calls.push({
			path: url.pathname,
			authorization: request.headers.get("authorization"),
			traceparent: request.headers.get("traceparent"),
		});
		if (url.pathname === "/v1/models")
			return Response.json({
				object: "list",
				data: models.map((id) => ({ id, object: "model" })),
			});
		if (url.pathname === "/v1/chat/completions") {
			const body = await request.json();
			return Response.json({
				model: body.model,
				choices: [{ message: { content: "OK" } }],
			});
		}
		return new Response("missing", { status: 404 });
	},
});
test.afterAll(() => upstream.stop(true));

test("Belt model proxy exposes the current upstream inventory without a fixed model list @unit", async () => {
	const proxy = createModelProxy({
		upstream: `http://127.0.0.1:${upstream.port}`,
	});
	const first = await proxy(new Request("http://belt.local/v1/models"));
	expect(first.status).toBe(200);
	expect(
		(await first.json()).data.map((item: { id: string }) => item.id),
	).toEqual(["qwen2.5:0.5b"]);
	models = ["qwen2.5:0.5b", "another-local-model"];
	const second = await proxy(new Request("http://belt.local/v1/models"));
	expect(
		(await second.json()).data.map((item: { id: string }) => item.id),
	).toEqual(["qwen2.5:0.5b", "another-local-model"]);
});

test("Belt model proxy forwards chat without disclosing Buckle's key @unit", async () => {
	const proxy = createModelProxy({
		upstream: `http://127.0.0.1:${upstream.port}`,
	});
	const response = await proxy(
		new Request("http://belt.local/v1/chat/completions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer private-buckle-key",
				traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
			},
			body: JSON.stringify({
				model: "qwen2.5:0.5b",
				messages: [{ role: "user", content: "OK" }],
			}),
		}),
	);
	expect(response.status).toBe(200);
	expect((await response.json()).model).toBe("qwen2.5:0.5b");
	expect(response.headers.get("x-klh-hop")).toBe("belt");
	expect(response.headers.get("x-klh-trace-id")).toBe(
		"1234567890abcdef1234567890abcdef",
	);
	expect(calls.at(-1)).toEqual({
		path: "/v1/chat/completions",
		authorization: null,
		traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
	});
});

test("Belt model proxy refuses unsupported paths and reports unreachable inventory @unit", async () => {
	const proxy = createModelProxy({ upstream: "http://127.0.0.1:1" });
	expect((await proxy(new Request("http://belt.local/admin"))).status).toBe(
		404,
	);
	const response = await proxy(new Request("http://belt.local/v1/models"));
	expect(response.status).toBe(503);
	expect(response.headers.get("x-klh-refusal")).toBe("network");
});
