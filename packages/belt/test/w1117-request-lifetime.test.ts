import { afterAll, expect, test } from "bun:test";
import { escalate } from "../bin/escalate.ts";
import { createModelProxy } from "../bin/model-proxy.ts";
import { openLocalStream, viaLocal } from "../bin/router-core.ts";

const upstream = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.headers.get("accept") === "text/event-stream") {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
							),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		await Bun.sleep(500);
		return Response.json({ choices: [{ message: { content: "late" } }] });
	},
});
afterAll(() => upstream.stop(true));

const base = `http://127.0.0.1:${upstream.port}`;

test("local non-stream call stops on incoming cancellation", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const call = viaLocal({ port: 8901, model: "test" }, [], 16, 0, {
		base,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(new Error("client gone")), 25);
	const result = await call;
	expect(result.ok).toBe(false);
	expect(Date.now() - started).toBeLessThan(400);
});

test("local stream body closes when request is cancelled after headers", async () => {
	const controller = new AbortController();
	const opened = await openLocalStream(
		{ port: 8901, model: "test" },
		[],
		16,
		0,
		{
			base,
			signal: controller.signal,
		},
	);
	expect(opened.ok).toBe(true);
	if (!opened.ok) return;
	const reader = opened.body.getReader();
	expect((await reader.read()).done).toBe(false);
	controller.abort(new Error("client gone"));
	await expect(reader.read()).rejects.toThrow();
});

test("model proxy terminates pending upstream fetch on caller cancellation", async () => {
	const controller = new AbortController();
	const proxy = createModelProxy({ upstream: base });
	const started = Date.now();
	const call = proxy(
		new Request("http://belt.local/v1/models", { signal: controller.signal }),
	);
	setTimeout(() => controller.abort(), 25);
	const response = await call;
	expect(response.status).toBe(499);
	expect(response.headers.get("x-klh-refusal")).toBe("client_cancelled");
	expect(Date.now() - started).toBeLessThan(400);
});

test("cloud escalation forwards cancellation to its fetch", async () => {
	const controller = new AbortController();
	let upstreamAborted = false;
	const call = escalate(
		{ model: "belt-router", max_tokens: 16, messages: [] },
		{
			maxTokens: 16,
			wantFast: true,
			env: {
				BELT_ESCALATE_URL: "https://gate.example",
				BELT_ESCALATE_KEY: "bksk_test",
			},
			signal: controller.signal,
			fetcher: (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						upstreamAborted = true;
						reject(new Error("aborted"));
					});
				}),
		},
	);
	controller.abort();
	await expect(call).rejects.toThrow("aborted");
	expect(upstreamAborted).toBe(true);
});

test("cloud escalation emits the inherited hop contract", async () => {
	let seen: string | null = null;
	await escalate(
		{ model: "belt-router", max_tokens: 16, messages: [] },
		{
			maxTokens: 16,
			wantFast: true,
			env: {
				BELT_ESCALATE_URL: "https://gate.example",
				BELT_ESCALATE_KEY: "bksk_test",
			},
			hopContract: {
				deadlineMs: 1_800_000_090_000,
				budget: 2,
				path: ["aaaaaaaaaaaaaaaa"],
			},
			fetcher: (_url, init) => {
				const headers = new Headers(init?.headers);
				seen = headers.get("x-klh-hop-contract");
				return Promise.resolve(
					Response.json({ content: [{ type: "text", text: "ok" }] }),
				);
			},
		},
	);
	// deadline passthrough absolute + belt's rung appended after the visited one
	expect(seen).toContain("deadline=1800000090000");
	expect(seen).toContain("path=aaaaaaaaaaaaaaaa,");
	expect(seen?.match(/budget=\d{1,2}/)?.[0]).toBe("budget=1");
});
