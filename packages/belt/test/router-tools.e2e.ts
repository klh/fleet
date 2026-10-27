// W789 — router tools bridge: anthropic ⇄ OpenAI translation on :4000.
// Stub servers only — never the live :890x fleet.
import { expect, test } from "@playwright/test";
import {
	anthropicSseFromOpenAi,
	toOpenAiMessages,
	toolCallsOf,
	toolChoiceToOpenAi,
	toOpenAiTools,
	viaLocal,
} from "../bin/router-core.ts";
import {
	anthropicMessagesToOpenAi,
	parseToolArgs,
} from "../bin/router-tools.ts";

test.describe("W789 tool request mappings", () => {
	test("toOpenAiTools maps anthropic tools and skips nameless @unit", () => {
		const defs = toOpenAiTools([
			{
				name: "get_weather",
				description: "Get weather",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
				},
			},
		]);
		expect(defs).toHaveLength(1);
		expect(defs?.[0]?.function.name).toBe("get_weather");
		expect(toOpenAiTools([])).toBeUndefined();
		expect(toOpenAiTools(undefined)).toBeUndefined();
	});
	test("toolChoiceToOpenAi maps auto/any/tool @unit", () => {
		expect(toolChoiceToOpenAi({ type: "auto" })).toBe("auto");
		expect(toolChoiceToOpenAi({ type: "any" })).toBe("required");
		expect(toolChoiceToOpenAi({ type: "tool", name: "x" })).toEqual({
			type: "function",
			function: { name: "x" },
		});
		expect(toolChoiceToOpenAi(undefined)).toBeUndefined();
	});
	test("toolCallsOf filters nameless entries @unit", () => {
		expect(
			toolCallsOf({
				tool_calls: [
					{
						id: "a",
						type: "function",
						function: { name: "f", arguments: "{}" },
					},
				],
			}),
		).toHaveLength(1);
		expect(toolCallsOf(undefined)).toEqual([]);
	});
});

test.describe("W789 tool history mapping", () => {
	test("toOpenAiMessages maps tool_use/tool_result @unit", () => {
		const hist = [
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
			},
		];
		const msgs = toOpenAiMessages({ messages: hist });
		expect(msgs.some((m) => m.role === "tool" && m.content === "ok")).toBe(
			true,
		);
		expect(msgs.some((m) => m.tool_calls?.[0]?.function.name === "f")).toBe(
			true,
		);
	});
	test("anthropicMessagesToOpenAi is the direct mapper @unit", () => {
		const direct = toOpenAiMessages({
			messages: [{ role: "user", content: "x" }],
		});
		expect(direct.length).toBe(2);
		expect(anthropicMessagesToOpenAi).toBeDefined();
	});
	test("parseToolArgs tolerates garbage @unit", () => {
		expect(parseToolArgs("")).toEqual({});
		expect(parseToolArgs("{bad")).toEqual({ _raw: "{bad" });
		expect(parseToolArgs('{"city":"CPH"}')).toEqual({ city: "CPH" });
	});
});

test.describe("W789 buffered tool_calls", () => {
	test("viaLocal surfaces tool calls @unit", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					choices: [
						{
							finish_reason: "tool_calls",
							message: {
								content: "",
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "get_weather",
											arguments: '{"city":"CPH"}',
										},
									},
								],
							},
						},
					],
				}),
		});
		const r = await viaLocal(
			{ port: srv.port, model: "stub" },
			[{ role: "user", content: "weather?" }],
			100,
			0.5,
			{ base: `http://localhost:${srv.port}` },
		);
		srv.stop(true);
		expect(r.ok).toBe(true);
		expect(r.toolCalls?.[0]?.function.name).toBe("get_weather");
		expect(r.finish).toBe("tool_calls");
	});
});

test.describe("W789 SSE tool stream", () => {
	test("discarded reasoning and non-selected choices cannot license an empty success @unit", async () => {
		for (const choices of [
			[{ delta: { reasoning_content: "hidden reasoning" } }],
			[
				{ delta: {} },
				{
					delta: {
						content: "discarded",
						tool_calls: [{ function: { name: "discarded_tool" } }],
					},
				},
			],
		]) {
			const upstream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({ choices })}\n\ndata: [DONE]\n\n`,
						),
					);
					c.close();
				},
			});
			const out = await new Response(
				anthropicSseFromOpenAi(upstream, { id: "discarded", model: "fixture" }),
			).text();
			expect(out).toContain('"code":"empty_response"');
			expect(out).not.toContain("event: message_delta");
		}
	});
	test("backend SSE error survives instead of becoming empty end-turn @unit", async () => {
		for (const error of [
			{ type: "internal_error", message: "Internal error during streaming" },
			{
				type: "rate_limit_error",
				code: "backpressure",
				message: "capacity exhausted",
			},
		]) {
			let outcome: { error?: string } | undefined;
			const upstream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`,
						),
					);
					c.close();
				},
			});
			const out = await new Response(
				anthropicSseFromOpenAi(
					upstream,
					{ id: "error", model: "fixture" },
					(result) => {
						outcome = result;
					},
				),
			).text();
			const payload = out
				.split("\n")
				.find((line) => line.startsWith('data: {"type":"error"'));
			expect(JSON.parse(payload?.slice(6) ?? "null").error).toEqual(error);
			expect(out).not.toContain("event: message_delta");
			expect(out).not.toContain('"type":"message_stop"');
			expect(outcome?.error).toBe("code" in error ? error.code : error.type);
		}
	});
	test("empty backend EOF is an error before any success stop delta @unit", async () => {
		let outcome: { error?: string } | undefined;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
				c.close();
			},
		});
		const out = await new Response(
			anthropicSseFromOpenAi(
				upstream,
				{ id: "empty", model: "fixture" },
				(result) => {
					outcome = result;
				},
			),
		).text();
		expect(out).toContain('"code":"empty_response"');
		expect(out).not.toContain("event: message_delta");
		expect(out).not.toContain('"type":"message_stop"');
		expect(outcome?.error).toBe("empty_response");
	});
	test("pump emits tool_use blocks @unit", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"checking"}}]}',
			"",
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather","arguments":""}}]}}]}',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"CPH\\"}"}}]}}]}',
			'data: {"choices":[{"finish_reason":"tool_calls"}]}',
			"data: [DONE]",
		].join("\n\n");
		const up = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(sse));
				c.close();
			},
		});
		const out = await new Response(
			anthropicSseFromOpenAi(up, { id: "m1", model: "stub" }),
		).text();
		expect(out).toContain('"type":"tool_use"');
		expect(out).toContain("input_json_delta");
		expect(out).toContain('"stop_reason":"tool_use"');
	});
});
