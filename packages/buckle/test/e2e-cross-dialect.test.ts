// test/e2e-cross-dialect.test.ts — W426 native dialect-translation tier:
// a request reaches a deployment of the OTHER dialect without any opt-in
// (pass-through-first: same-dialect hops still rank first). An anthropic
// client reaches an openai upstream — JSON + streaming through
// OpenAIToAnthropicStream; an openai client reaches an anthropic upstream —
// JSON + streaming through the AnthropicToOpenAIStream mirror.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { type MockUpstream, startMockUpstream } from "./mock.ts";

const GROUP = "duo";

function poolOf(deps: Array<Omit<Deployment, "group">>): UpstreamPool {
	return {
		groups: () => [GROUP],
		deployments: (g) =>
			g === GROUP ? deps.map((d) => ({ ...d, group: g })) : [],
	};
}

const overloaded = (): Promise<MockUpstream> =>
	startMockUpstream(() =>
		Response.json(
			{ type: "error", error: { type: "overloaded_error", message: "busy" } },
			{ status: 529 },
		),
	);

const sse = (frames: unknown[]): string =>
	`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;

// anthropic upstream SSE: a text block, finish + usage on message_delta.
const anthropicFrame = (event: string, data: unknown): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const ANTHROPIC_STREAM_HEAD = [
	anthropicFrame("message_start", {
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-x",
			content: [],
			usage: { input_tokens: 7, output_tokens: 0 },
		},
	}),
	anthropicFrame("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}),
	anthropicFrame("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "he" },
	}),
	anthropicFrame("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "y" },
	}),
	anthropicFrame("content_block_stop", {
		type: "content_block_stop",
		index: 0,
	}),
];

const ANTHROPIC_STREAM_TAIL = [
	anthropicFrame("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 3 },
	}),
	anthropicFrame("message_stop", { type: "message_stop" }),
];
const ANTHROPIC_STREAM = [
	...ANTHROPIC_STREAM_HEAD,
	...ANTHROPIC_STREAM_TAIL,
].join("");

const OPENAI_STREAM = sse([
	{
		id: "c1",
		model: "gpt-x",
		choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
	},
	{
		id: "c1",
		model: "gpt-x",
		choices: [{ index: 0, delta: { content: "lo ☃" } }],
	},
	{
		id: "c1",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "get", arguments: '{"q":' },
						},
					],
				},
			},
		],
	},
	{
		id: "c1",
		choices: [
			{
				index: 0,
				delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
			},
		],
	},
	{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	{ id: "c1", choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } },
]);

function parseSse(
	text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
	return text
		.split("\n\n")
		.filter((b) => b.trim().length > 0)
		.map((b) => {
			const ev = /^event: (.*)$/m.exec(b)?.[1] ?? "";
			const data = /^data: (.*)$/m.exec(b)?.[1] ?? "{}";
			return { event: ev, data: JSON.parse(data) as Record<string, unknown> };
		});
}

const anthropicReq = (url: string, stream: boolean): Request =>
	new Request(`${url}/v1/messages`, {
		method: "POST",
		body: JSON.stringify({
			model: GROUP,
			stream,
			max_tokens: 64,
			system: "be brief",
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{ name: "get", description: "d", input_schema: { type: "object" } },
			],
		}),
	});

describe("native dialect translation (W426)", () => {
	test("default: anthropic client reaches a SOLO openai upstream (the W1 502 wall falls)", async () => {
		const oai = await startMockUpstream(() =>
			Response.json({
				id: "c2",
				model: "gpt-x",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "yo" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 2 },
			}),
		);
		const d = testDeps(poolOf([{ url: oai.url, dialect: "openai" }]), {
			sleepMs: async () => {},
		});
		const res = await createApp(d).fetch(anthropicReq(oai.url, false));
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("x-belt-route") ?? "{}").decision).toBe(
			"policy",
		);
		const msg = (await res.json()) as Record<string, unknown>;
		expect(msg).toMatchObject({
			type: "message",
			content: [{ type: "text", text: "yo" }],
			stop_reason: "end_turn",
		});
		await Bun.sleep(10);
		expect(d.ledger.rows()[0]?.in_tok).toBe(4);
		oai.close();
	});

	test("anthropic streaming client fails over to openai, e2e SSE translated", async () => {
		const ant = await overloaded();
		const oai = await startMockUpstream(
			() =>
				new Response(OPENAI_STREAM, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const d = testDeps(
			poolOf([
				{ url: ant.url, dialect: "anthropic" },
				{ url: oai.url, dialect: "openai" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(anthropicReq(ant.url, true));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(JSON.parse(res.headers.get("x-belt-route") ?? "{}").decision).toBe(
			"fallback",
		);
		const events = parseSse(await res.text());
		expect(events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const text = events
			.filter((e) => (e.data.delta as { type?: string })?.type === "text_delta")
			.map((e) => (e.data.delta as { text: string }).text)
			.join("");
		expect(text).toBe("Hello ☃");
		const json = events
			.filter(
				(e) => (e.data.delta as { type?: string })?.type === "input_json_delta",
			)
			.map((e) => (e.data.delta as { partial_json: string }).partial_json)
			.join("");
		expect(JSON.parse(json)).toEqual({ q: "x" });
		const tool = events[5]?.data.content_block as Record<string, unknown>;
		expect(tool).toMatchObject({ type: "tool_use", id: "call_1", name: "get" });
		const md = events[9]?.data as {
			delta: { stop_reason: string };
			usage: { output_tokens: number; input_tokens: number };
		};
		expect(md.delta.stop_reason).toBe("tool_use");
		expect(md.usage).toEqual({ output_tokens: 9, input_tokens: 21 });

		// the openai leg got an openai body: system message, tools, usage opt-in
		const sent = oai.calls[0];
		expect(sent?.path).toBe("/v1/chat/completions");
		const body = sent?.body as Record<string, unknown>;
		expect((body.messages as Array<{ role: string }>)[0]?.role).toBe("system");
		expect(body.system).toBeUndefined();
		expect(body.stream_options).toEqual({ include_usage: true });
		expect((body.tools as Array<{ type: string }>)[0]?.type).toBe("function");

		await Bun.sleep(10);
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(21);
		expect(row.out_tok).toBe(9);
		ant.close();
		oai.close();
	});

	test("anthropic JSON client gets an anthropic message from an openai upstream", async () => {
		const ant = await overloaded();
		const oai = await startMockUpstream(() =>
			Response.json({
				id: "c2",
				model: "gpt-x",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "yo" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 2 },
			}),
		);
		const d = testDeps(
			poolOf([
				{ url: ant.url, dialect: "anthropic" },
				{ url: oai.url, dialect: "openai" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(anthropicReq(ant.url, false));
		expect(res.status).toBe(200);
		const msg = (await res.json()) as Record<string, unknown>;
		expect(msg).toMatchObject({
			type: "message",
			content: [{ type: "text", text: "yo" }],
			stop_reason: "end_turn",
		});
		await Bun.sleep(10);
		expect(d.ledger.rows()[0]?.in_tok).toBe(4);
		ant.close();
		oai.close();
	});

	test("openai JSON client fails over to an anthropic upstream", async () => {
		const oaiDown = await startMockUpstream(() =>
			Response.json({ error: { message: "down" } }, { status: 503 }),
		);
		const ant = await startMockUpstream(() =>
			Response.json({
				id: "msg_9",
				type: "message",
				model: "claude-x",
				content: [{ type: "text", text: "hey" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 7, output_tokens: 3 },
			}),
		);
		const d = testDeps(
			poolOf([
				{ url: oaiDown.url, dialect: "openai" },
				{ url: ant.url, dialect: "anthropic" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(
			new Request(`${ant.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [
						{ role: "system", content: "s" },
						{ role: "user", content: "hi" },
					],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			object: string;
			choices: Array<{ message: { content: string }; finish_reason: string }>;
		};
		expect(out.object).toBe("chat.completion");
		expect(out.choices[0]?.message.content).toBe("hey");
		expect(out.choices[0]?.finish_reason).toBe("stop");
		const sent = ant.calls[0]?.body as Record<string, unknown>;
		expect(ant.calls[0]?.path).toBe("/v1/messages");
		expect(sent.system).toBe("s");
		expect(sent.max_tokens).toBe(4096);
		oaiDown.close();
		ant.close();
	});

	test("openai STREAMING client hops to anthropic, e2e SSE mirrored", async () => {
		const oaiDown = await startMockUpstream(() =>
			Response.json({ error: { message: "down" } }, { status: 503 }),
		);
		const ant = await startMockUpstream(
			() =>
				new Response(ANTHROPIC_STREAM, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const d = testDeps(
			poolOf([
				{ url: oaiDown.url, dialect: "openai" },
				{ url: ant.url, dialect: "anthropic" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(
			new Request(`${ant.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const frames = (await res.text())
			.split("\n\n")
			.filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
			.map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
		const bodyText = JSON.stringify(frames);
		expect(bodyText).toContain('"role":"assistant"');
		expect(bodyText).toContain('"content":"he"');
		expect(bodyText).toContain('"content":"y"');
		expect(bodyText).toContain('"finish_reason":"stop"');
		expect(bodyText).toContain('"prompt_tokens":7');
		expect(bodyText).toContain('"completion_tokens":3');
		await Bun.sleep(10);
		expect(d.ledger.rows()[0]?.in_tok).toBe(7);
		expect(d.ledger.rows()[0]?.out_tok).toBe(3);
		oaiDown.close();
		ant.close();
	});
});
