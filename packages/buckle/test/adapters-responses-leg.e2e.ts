// test/adapters-responses-leg.e2e.ts — W2583: the Responses-wire adapter
// family. A chat client (or an anthropic client via the composed W426
// bridge) reaches a responses-only upstream: the request rides chat→
// Responses translation, the reply re-frames back to the client wire, usage
// lands in the ledger, and the /v1/responses ingress stays byte-identical
// pass-through. Reject-verbose: a tools shape with no Responses equivalent
// skips the rung (502 not-bridgeable on a solo pool), zero upstream calls.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

test.describe("@api", () => {
	const GROUP = "gpt-6-sol";

	const depOf = (url: string): Deployment => ({
		group: GROUP,
		url,
		dialect: "openai",
		adapter: "openai-responses",
	});

	const poolOf = (url: string): UpstreamPool => ({
		groups: () => [GROUP],
		deployments: (g) => (g === GROUP ? [depOf(url)] : []),
	});

	const RESPONSES_OK = {
		id: "resp_1",
		object: "response",
		model: GROUP,
		status: "completed",
		output: [
			{ type: "message", content: [{ type: "output_text", text: "heya" }] },
		],
		usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
	};

	test("non-streaming chat client: request translates, reply re-frames, usage lands", async () => {
		const upstream = await startMockUpstream(() => Response.json(RESPONSES_OK));
		const d = testDeps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [
						{ role: "system", content: "be brief" },
						{ role: "user", content: "hi" },
					],
					max_tokens: 64,
				}),
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			choices: Array<{ message: { content: string }; finish_reason: string }>;
			usage: { prompt_tokens: number; completion_tokens: number };
		};
		expect(out.choices[0]?.message.content).toBe("heya");
		expect(out.choices[0]?.finish_reason).toBe("stop");
		expect(out.usage.prompt_tokens).toBe(1);
		expect(out.usage.completion_tokens).toBe(2);
		expect(upstream.calls[0]?.path).toBe("/v1/responses");
		const sent = upstream.calls[0]?.body as Record<string, unknown>;
		expect(sent.model).toBe(GROUP);
		expect(sent.instructions).toBe("be brief");
		expect(sent.max_output_tokens).toBe(64);
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(1);
		expect(row.out_tok).toBe(2);
		upstream.close();
	});

	test("anthropic client: composed bridge reaches the responses upstream", async () => {
		const upstream = await startMockUpstream(() => Response.json(RESPONSES_OK));
		const app = createApp(testDeps(poolOf(upstream.url)));
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					max_tokens: 64,
					system: "be brief",
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls[0]?.path).toBe("/v1/responses");
		const out = (await res.json()) as {
			type: string;
			content: Array<{ type: string; text: string }>;
			stop_reason: string;
			usage: { input_tokens: number; output_tokens: number };
		};
		expect(out.type).toBe("message");
		expect(out.content[0]?.text).toBe("heya");
		expect(out.stop_reason).toBe("end_turn");
		expect(out.usage.input_tokens).toBe(1);
		expect(out.usage.output_tokens).toBe(2);
		upstream.close();
	});

	test("tools shape has no Responses equivalent: rung skipped, zero upstream calls", async () => {
		const upstream = await startMockUpstream(() => Response.json(RESPONSES_OK));
		const app = createApp(testDeps(poolOf(upstream.url)));
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [{ role: "user", content: "hi" }],
					tools: [
						{
							type: "function",
							function: { name: "get", parameters: { type: "object" } },
						},
					],
				}),
			}),
		);
		expect(res.status).toBe(502);
		expect(upstream.calls).toHaveLength(0);
		upstream.close();
	});

	test("responses-native client: /v1/responses ingress stays byte-identical pass-through", async () => {
		const raw = JSON.stringify(RESPONSES_OK);
		const upstream = await startMockUpstream(
			() =>
				new Response(raw, {
					headers: { "content-type": "application/json" },
				}),
		);
		const app = createApp(testDeps(poolOf(upstream.url)));
		const body = JSON.stringify({ model: GROUP, input: "say heya" });
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/responses`, {
				method: "POST",
				body,
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(raw);
		expect(upstream.calls[0]?.path).toBe("/v1/responses");
		upstream.close();
	});
});
