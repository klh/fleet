import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { sseReframer } from "../src/sse.ts";

const enc = new TextEncoder();
const frame = (type: string, data: unknown) =>
	`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const head = frame("message_start", {
	type: "message_start",
	message: {
		id: "fixture",
		type: "message",
		role: "assistant",
		model: "fixture",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 0 },
	},
});
const stopDelta = frame("message_delta", {
	type: "message_delta",
	delta: { stop_reason: "end_turn", stop_sequence: null },
	usage: { output_tokens: 0 },
});
const stop = frame("message_stop", { type: "message_stop" });
const text =
	frame("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}) +
	frame("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "ok" },
	}) +
	frame("content_block_stop", { type: "content_block_stop", index: 0 });
function response(body: string, dialect?: "anthropic" | "openai"): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(enc.encode(body));
			c.close();
		},
	});
	return new Response(
		dialect ? stream.pipeThrough(sseReframer(undefined, dialect)) : stream,
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function anthropic(body: string, guarded = true) {
	const client = new Anthropic({
		apiKey: "fixture",
		maxRetries: 0,
		fetch: async () => response(body, guarded ? "anthropic" : undefined),
	});
	return client.messages.stream({
		model: "fixture",
		max_tokens: 1,
		messages: [{ role: "user", content: "fixture" }],
	});
}

test("real Anthropic SDK accepts raw empty end-turn but guarded turn has no successful snapshot", async () => {
	const raw = await anthropic(head + stopDelta + stop, false).finalMessage();
	expect(raw.stop_reason).toBe("end_turn");
	expect(raw.content).toEqual([]);
	const guarded = anthropic(head + stopDelta + stop);
	const successes: string[] = [];
	guarded.on("streamEvent", (_event, snapshot) => {
		if (snapshot.stop_reason) successes.push(snapshot.stop_reason);
	});
	await expect(guarded.finalMessage()).rejects.toThrow(
		"without usable assistant output",
	);
	expect(successes).toEqual([]);
});

test("real Anthropic SDK preserves usable content and real source errors outrank held success", async () => {
	const good = await anthropic(head + text + stopDelta + stop).finalMessage();
	expect(good.content).toEqual([{ type: "text", text: "ok" }]);
	expect(good.stop_reason).toBe("end_turn");
	const sourceError = frame("error", {
		type: "error",
		error: {
			type: "rate_limit_error",
			code: "1302",
			message: "account concurrency",
		},
	});
	const failed = anthropic(head + text + stopDelta + sourceError + stop);
	const successes: string[] = [];
	failed.on("streamEvent", (_event, snapshot) => {
		if (snapshot.stop_reason) successes.push(snapshot.stop_reason);
	});
	await expect(failed.finalMessage()).rejects.toThrow("account concurrency");
	expect(successes).toEqual([]);
});

const chunk = (content: string, finish_reason: string | null = null) =>
	`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] })}\n\n`;
async function openai(
	body: string,
	seen: Array<{ content?: string; finish?: string | null }>,
) {
	const client = new OpenAI({
		apiKey: "fixture",
		maxRetries: 0,
		fetch: async () => response(body, "openai"),
	});
	const stream = await client.chat.completions.create({
		model: "fixture",
		messages: [{ role: "user", content: "fixture" }],
		stream: true,
	});
	for await (const event of stream)
		for (const choice of event.choices)
			seen.push({
				content: choice.delta.content ?? undefined,
				finish: choice.finish_reason,
			});
}

test("real OpenAI SDK sees no empty success finish and mixed content/finish streams exactly once", async () => {
	const empty: Array<{ content?: string; finish?: string | null }> = [];
	await expect(
		openai(`${chunk("", "stop")}data: [DONE]\n\n`, empty),
	).rejects.toThrow("without usable assistant output");
	expect(empty.filter((part) => part.finish)).toEqual([]);
	const valid: Array<{ content?: string; finish?: string | null }> = [];
	await openai(`${chunk("ok", "stop")}data: [DONE]\n\n`, valid);
	expect(valid.map((part) => part.content ?? "").join("")).toBe("ok");
	expect(valid.filter((part) => part.finish)).toEqual([
		{ content: undefined, finish: "stop" },
	]);
});

test("truncated and oversized terminal metadata cannot leak a success finish", async () => {
	await expect(
		anthropic(head + text + stopDelta).finalMessage(),
	).rejects.toThrow();
	const huge = frame("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		extra: "x".repeat(17000),
	});
	await expect(
		anthropic(head + text + huge + stop).finalMessage(),
	).rejects.toThrow("terminal metadata exceeds");
});

test("content remains streamed while only success metadata waits for protocol terminal", async () => {
	let source!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			source = c;
		},
	});
	const reader = body
		.pipeThrough(sseReframer(undefined, "anthropic"))
		.getReader();
	source.enqueue(enc.encode(head + text + stopDelta));
	let before = "";
	while (!before.includes('"text":"ok"')) {
		const next = await reader.read();
		before += new TextDecoder().decode(next.value);
	}
	expect(before).not.toContain('"stop_reason":"end_turn"');
	source.enqueue(enc.encode(stop));
	source.close();
	let after = "";
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		after += new TextDecoder().decode(next.value);
	}
	expect(after.indexOf("event: message_delta")).toBeLessThan(
		after.indexOf("event: message_stop"),
	);
	expect(after.match(/"stop_reason":"end_turn"/g)).toHaveLength(1);
});

test("OpenAI source error and truncated EOF never release held successful finish", async () => {
	for (const suffix of [
		"",
		'data: {"error":{"type":"rate_limit_error","code":"1302","message":"account concurrency"}}\n\ndata: [DONE]\n\n',
	]) {
		const seen: Array<{ content?: string; finish?: string | null }> = [];
		try {
			await openai(chunk("ok", "stop") + suffix, seen);
		} catch (error) {
			expect(String(error)).toContain("account concurrency");
		}
		expect(seen.map((part) => part.content ?? "").join("")).toBe("ok");
		expect(seen.filter((part) => part.finish)).toEqual([]);
	}
});

test("OpenAI held terminal keeps choice metadata and usage exactly once", async () => {
	const logprobs = {
		content: [
			{ token: "ok", logprob: -0.1, bytes: [111, 107], top_logprobs: [] },
		],
	};
	for (const content of ["", "ok"]) {
		const terminal = {
			id: "fixture",
			choices: [
				{
					index: 0,
					delta: content ? { content } : {},
					finish_reason: "stop",
					logprobs,
					custom_terminal: "preserved",
				},
			],
			usage: { completion_tokens: 1 },
		};
		const input =
			(content ? "" : chunk("ok")) +
			`data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`;
		const out = await response(input, "openai").text();
		const frames = out
			.split("\n")
			.filter((line) => line.startsWith("data: {"))
			.map((line) => JSON.parse(line.slice(6)));
		const successes = frames
			.flatMap((frame) => frame.choices ?? [])
			.filter((choice: { finish_reason?: string }) => choice.finish_reason);
		expect(successes).toHaveLength(1);
		expect(successes[0]).toMatchObject({
			logprobs,
			custom_terminal: "preserved",
		});
		expect(frames.filter((frame) => frame.usage)).toHaveLength(1);
		expect(out.match(/custom_terminal/g)).toHaveLength(1);
	}
});
