// w960-tool-usage-telemetry.test.ts — W2182 re-land of W960.1: the router
// keeps tools and real usage end-to-end. Stub fetchers / stub specialist
// only; never the live swarm. Covers: parseUpstreamUsage field picking,
// escalate() forwarding tools/tool_choice + parsing tool_use blocks + usage,
// the buffered SSE blocks translator, and viaLocal usage passthrough.
import { describe, expect, test } from "bun:test";
import { escalate } from "../bin/escalate.ts";
import {
	type AnthropicBody,
	anthropicSseFromBlocks,
	anthropicSseFromText,
	parseUpstreamUsage,
	viaLocal,
} from "../bin/router-core.ts";

const TOOLS = [
	{
		name: "write_file",
		description: "Write a file",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

describe("W960 parseUpstreamUsage", () => {
	test("picks present fields, drops absent ones, keeps sent zeros", () => {
		expect(
			parseUpstreamUsage({
				prompt_tokens: 14,
				completion_tokens: 11,
				prompt_tokens_details: { cached_tokens: 13 },
			}),
		).toEqual({
			inputTokens: 14,
			outputTokens: 11,
			cacheReadTokens: 13,
		});
	});
	test("sent zeros stay, absent fields stay absent", () => {
		expect(parseUpstreamUsage({ prompt_tokens: 0 })).toEqual({
			inputTokens: 0,
		});
		expect(parseUpstreamUsage(undefined)).toBeUndefined();
	});
});

describe("W960 escalate() forwards tools + parses the answer", () => {
	test("request body carries tools and tool_choice verbatim", async () => {
		let seenBody: Record<string, unknown> = {};
		const fetcher = (async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			seenBody = JSON.parse(String(init?.body));
			return Response.json({ content: [{ type: "text", text: "OK" }] });
		}) as typeof fetch;
		const body: AnthropicBody = {
			model: "glm-5.3-flash",
			max_tokens: 64,
			tools: TOOLS,
			tool_choice: { type: "auto" },
			messages: [{ role: "user", content: "Reply OK" }],
		};
		await escalate(body, {
			maxTokens: 64,
			wantFast: true,
			env: {
				BELT_ESCALATE_URL: "http://127.0.0.1:4101",
				BELT_ESCALATE_KEY: "bksk_test",
			},
			fetcher,
		});
		expect(seenBody.tools).toEqual(TOOLS);
		expect(seenBody.tool_choice).toEqual({ type: "auto" });
	});

	test("tool_use answer becomes toolUses + usage on the result", async () => {
		const fetcher = (async () =>
			Response.json({
				content: [
					{ type: "text", text: "Creating" },
					{
						type: "tool_use",
						id: "call_x",
						name: "write_file",
						input: { path: "a.txt" },
					},
				],
				usage: { input_tokens: 120, output_tokens: 34 },
			})) as typeof fetch;
		const r = await escalate(
			{
				model: "glm-5.3-flash",
				max_tokens: 64,
				tools: TOOLS,
				messages: [{ role: "user", content: "Create a.txt" }],
			},
			{
				maxTokens: 64,
				wantFast: true,
				env: {
					BELT_ESCALATE_URL: "http://127.0.0.1:4101",
					BELT_ESCALATE_KEY: "bksk_test",
				},
				fetcher,
			},
		);
		expect(r.text).toBe("Creating");
		expect(r.toolUses?.[0]?.name).toBe("write_file");
		expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
	});
});

describe("W960 buffered SSE carries blocks + usage", () => {
	test("tool_use block streams as start + input_json_delta", async () => {
		const stream = anthropicSseFromBlocks(
			[
				{ type: "text", text: "hi" },
				{
					type: "tool_use",
					id: "call_1",
					name: "Bash",
					input: { command: "ls" },
				},
			],
			{ id: "m", model: "glm-5.3-flash" },
		);
		const txt = await new Response(stream).text();
		expect(txt).toContain('"name":"Bash"');
		expect(txt).toContain('"partial_json"');
		expect(txt).toContain('"stop_reason":"end_turn"');
		// W2182: the tool block is the SECOND block — its index must advance.
		expect(txt).toContain('"index":1');
	});

	test("usage fields ride the tail (blocks + text forms)", async () => {
		const t1 = await new Response(
			anthropicSseFromText("pong", { id: "m", model: "x" }, undefined, {
				inputTokens: 3,
				outputTokens: 1,
			}),
		).text();
		expect(t1).toContain('"text_delta","text":"pong"');
		expect(t1).toContain('"input_tokens":3');
		const t2 = await new Response(
			anthropicSseFromBlocks(
				[{ type: "text", text: "hi" }],
				{ id: "m", model: "x" },
				undefined,
				{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 },
			),
		).text();
		expect(t2).toContain('"input_tokens":10');
		expect(t2).toContain('"output_tokens":5');
		expect(t2).toContain('"cache_read_input_tokens":7');
	});
});

describe("W960 viaLocal usage passthrough", () => {
	test("non-stream specialist usage lands on the result", async () => {
		const stub = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					choices: [{ finish_reason: "stop", message: { content: "hi" } }],
					usage: { prompt_tokens: 14, completion_tokens: 11 },
				}),
		});
		try {
			const r = await viaLocal(
				{ port: stub.port, model: "stub" },
				[{ role: "user", content: "hi" }],
				64,
				0.7,
				{ base: `http://localhost:${stub.port}` },
			);
			expect(r.ok).toBe(true);
			expect(r.usage).toEqual({ inputTokens: 14, outputTokens: 11 });
		} finally {
			stub.stop(true);
		}
	});
});
