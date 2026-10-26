import { test, expect } from "@playwright/test";
import { laneProbeReply } from "./lane-probe-sse.ts";

test.describe("@unit", () => {
	test("stream probe reconstructs tool input, signature, and stop reason", async () => {
		const events = [
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "read" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "signed" },
			},
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "call_1",
					name: "fleet_health_read",
					input: {},
				},
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"path":"health' },
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '.txt"}' },
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" } },
			{ type: "message_stop" },
		];
		const body = events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join("");
		const reply = await laneProbeReply(new Response(body));
		expect(reply.stop_reason).toBe("tool_use");
		expect(reply.content).toEqual([
			{ type: "thinking", thinking: "read", signature: "signed" },
			{
				type: "tool_use",
				id: "call_1",
				name: "fleet_health_read",
				input: { path: "health.txt" },
			},
		]);
	});

	test("incomplete stream cannot report healthy", async () => {
		await expect(
			laneProbeReply(
				new Response(
					'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
				),
			),
		).rejects.toThrow("message_stop");
	});
});
