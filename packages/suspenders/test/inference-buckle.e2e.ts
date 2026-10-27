import { expect, test } from "./pw";
import {
	buckleChat,
	HINT_HEADER,
	inferenceBuckleRoute,
	inferenceHeaders,
} from "../hooks/lib/hub/inference-buckle.ts";

const ENV = {
	SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_proxy_test",
};

test.describe("inference Buckle route", () => {
	test("resolves the shared knowledge-buckle credential pair", () => {
		const r = inferenceBuckleRoute(ENV);
		expect(r.base.origin).toBe("http://127.0.0.1:4101");
		expect(r.token).toBe("bksk_proxy_test");
	});

	test("fails closed when the scoped key is absent", () => {
		expect(() =>
			inferenceBuckleRoute({ SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" }),
		).toThrow("together");
	});

	test("rejects non-scoped keys — no admin/root inference", () => {
		expect(() =>
			inferenceBuckleRoute({
				SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
				SUSPENDERS_BUCKLE_TOKEN: "root-key",
			}),
		).toThrow("scoped");
	});
});

test.describe("inference headers", () => {
	test("carries credential, wire version, hint and trace", () => {
		const h = inferenceHeaders({
			token: "bksk_proxy_test",
			wire: "anthropic",
			hint: "prefer local reasoning",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		});
		expect(h["x-api-key"]).toBe("bksk_proxy_test");
		expect(h.authorization).toBe("Bearer bksk_proxy_test");
		expect(h["anthropic-version"]).toBe("2023-06-01");
		expect(h[HINT_HEADER]).toBe("prefer local reasoning");
		expect(h.traceparent).toBe(
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		);
	});

	test("rejects an oversized hint before the wire", () => {
		expect(() =>
			inferenceHeaders({
				token: "bksk_proxy_test",
				wire: "anthropic",
				hint: "x".repeat(513),
			}),
		).toThrow("512 bytes");
	});
});

test.describe("buckleChat", () => {
	test("POSTs the anthropic wire to the gate and reads text back", async () => {
		let seenUrl = "";
		let seenAuth = "";
		const result = await buckleChat(
			{
				model: "local-extract",
				system: "s",
				user: "u",
				maxTokens: 42,
				// biome-ignore lint/suspicious/noExplicitAny: test fetcher probe
				fetcher: (async (input: any, init?: any) => {
					seenUrl = String(input);
					seenAuth = String(init?.headers?.authorization ?? "");
					return new Response(
						JSON.stringify({
							model: "served-id",
							content: [{ type: "text", text: "hi" }],
						}),
						{ status: 200 },
					);
				}) as unknown as typeof fetch,
			},
			ENV,
		);
		expect(seenUrl).toBe("http://127.0.0.1:4101/v1/messages");
		expect(seenAuth).toBe("Bearer bksk_proxy_test");
		expect(result.text).toBe("hi");
		expect(result.model).toBe("served-id");
	});

	test("throws (no fallback) on gate HTTP failure", async () => {
		let calls = 0;
		await expect(
			buckleChat(
				{
					model: "m",
					user: "u",
					fetcher: (async () => {
						calls++;
						return new Response("secret-prompt-echo", {
							status: 503,
							headers: { "x-klh-trace-id": "a".repeat(32) },
						});
					}) as unknown as typeof fetch,
				},
				ENV,
			),
		).rejects.toThrow("HTTP 503");
		expect(calls).toBe(1);
	});

	test("openai wire POSTs the chat-completions path", async () => {
		let seenUrl = "";
		await buckleChat(
			{
				model: "m",
				user: "u",
				wire: "openai",
				fetcher: (async (input: unknown) => {
					seenUrl = String(input);
					return new Response(
						JSON.stringify({
							model: "served",
							choices: [{ message: { content: "ok" } }],
						}),
						{ status: 200 },
					);
				}) as unknown as typeof fetch,
			},
			ENV,
		);
		expect(seenUrl).toBe("http://127.0.0.1:4101/v1/chat/completions");
	});

	test("result carries buckle's x-klh-trace-id response identity", async () => {
		const result = await buckleChat(
			{
				model: "m",
				user: "u",
				fetcher: (async () =>
					new Response(
						JSON.stringify({ content: [{ type: "text", text: "x" }] }),
						{
							status: 200,
							headers: { "x-klh-trace-id": "b".repeat(32) },
						},
					)) as unknown as typeof fetch,
			},
			ENV,
		);
		expect(result.traceId).toBe("b".repeat(32));
	});

	test("error text stays bounded — no upstream body, trace id only", async () => {
		try {
			await buckleChat(
				{
					model: "m",
					user: "u",
					fetcher: (async () =>
						new Response("prompt-and-key-echo", {
							status: 500,
						})) as unknown as typeof fetch,
				},
				ENV,
			);
			expect.unreachable();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).not.toContain("prompt-and-key-echo");
			expect(msg).toContain("trace");
		}
	});
});
