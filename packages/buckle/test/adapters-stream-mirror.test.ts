// test/adapters-stream-mirror.test.ts — W426: the anthropic→openai chunk
// mirror (AnthropicToOpenAIStream), the counterpart of
// OpenAIToAnthropicStream. Fixture-pinned per the W134 §5 table: role chunk
// on message_start, text deltas, tool blocks → sequential openai tool
// indexes, finish on message_delta's stop_reason, ONE terminal usage chunk
// (include_usage semantics), [DONE] left to the bridge.
import { describe, expect, test } from "bun:test";
import { AnthropicToOpenAIStream } from "../src/adapters/tools.ts";

const ev = (type: string, extra: Record<string, unknown> = {}) => ({
	event: type,
	data: { type, ...extra },
});

describe("AnthropicToOpenAIStream", () => {
	test("text stream → role/content chunks, finish, terminal usage", () => {
		const tx = new AnthropicToOpenAIStream();
		const chunks = [
			...tx.push(
				ev("message_start", {
					message: {
						id: "m1",
						model: "claude-x",
						usage: { input_tokens: 7 },
					},
				}),
			),
			...tx.push(
				ev("content_block_delta", {
					index: 0,
					delta: { type: "text_delta", text: "he" },
				}),
			),
		];
		expect(chunks[0]).toMatchObject({
			id: "m1",
			object: "chat.completion.chunk",
			model: "claude-x",
			choices: [
				{ index: 0, delta: { role: "assistant" }, finish_reason: null },
			],
		});
		expect(chunks[1]).toMatchObject({
			choices: [{ delta: { content: "he" }, finish_reason: null }],
		});
		// __MORE__
		const tail = [
			...tx.push(
				ev("content_block_delta", {
					index: 0,
					delta: { type: "text_delta", text: "y" },
				}),
			),
			...tx.push(ev("content_block_stop", { index: 0 })),
			...tx.push(
				ev("message_delta", {
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 3 },
				}),
			),
			...tx.push(ev("message_stop", {})),
			...tx.flush(), // message_stop already finished it: flush adds nothing
		];
		expect(tail.at(-2)).toMatchObject({
			choices: [{ delta: {}, finish_reason: "stop" }],
		});
		expect(tail.at(-1)).toMatchObject({
			choices: [],
			usage: { prompt_tokens: 7, completion_tokens: 3 },
		});
		expect(tx.seenUsage()).toMatchObject({ in_tok: 7, out_tok: 3 });
	});

	test("tool_use block → sequential openai tool index + argument fragments", () => {
		const tx = new AnthropicToOpenAIStream();
		const chunks = [
			...tx.push(
				ev("message_start", {
					message: { id: "m2", model: "claude-x", usage: {} },
				}),
			),
			...tx.push(
				ev("content_block_start", {
					index: 1,
					content_block: { type: "tool_use", id: "t1", name: "get" },
				}),
			),
			...tx.push(
				ev("content_block_delta", {
					index: 1,
					delta: { type: "input_json_delta", partial_json: '{"q":' },
				}),
			),
		];
		const tail = [
			...tx.push(
				ev("content_block_delta", {
					index: 1,
					delta: { type: "input_json_delta", partial_json: '"x"}' },
				}),
			),
			...tx.push(ev("message_delta", { delta: { stop_reason: "tool_use" } })),
			...tx.flush(),
		];
		const all = [...chunks, ...tail];
		const calls = all.flatMap(
			(c) =>
				((c.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta
					.tool_calls as Array<Record<string, unknown>>) ?? [],
		);
		expect(calls[0]).toMatchObject({
			index: 0,
			id: "t1",
			function: { name: "get", arguments: "" },
		});
		expect(calls.at(-1)).toMatchObject({
			index: 0,
			function: { arguments: '"x"}' },
		});
		const finished = all.find(
			(c) =>
				(c.choices as Array<{ finish_reason: string }>)[0]?.finish_reason ===
				"tool_calls",
		);
		expect(finished).toBeDefined();
	});

	test("pre-envelope events flush empty — never a fabricated envelope", () => {
		const tx = new AnthropicToOpenAIStream();
		expect(tx.push(ev("ping"))).toEqual([]);
		expect(tx.flush()).toEqual([]);
	});
});
