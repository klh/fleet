import { expect, test } from "bun:test";
import { laneToolRoundtrip } from "./lane-tool-probe.ts";

const structured = {
	stop_reason: "tool_use",
	content: [
		{
			type: "thinking",
			thinking: "read health",
			signature: "provider-signature",
		},
		{
			type: "tool_use",
			id: "call_1",
			name: "fleet_health_read",
			input: { path: "health.txt" },
		},
	],
};

test("tool-less XML response is unhealthy despite HTTP success", async () => {
	const result = await laneToolRoundtrip(async () => ({
		stop_reason: "end_turn",
		content: [
			{ type: "text", text: "<tool_code_read>health.txt</tool_code_read>" },
		],
	}));
	expect(result.ok).toBe(false);
});

test("roundtrip preserves thinking and links result to exact tool id", async () => {
	const requests: Record<string, unknown>[] = [];
	const result = await laneToolRoundtrip(async (body) => {
		// Snapshot the messages before the next turn appends to the array.
		requests.push(structuredClone(body));
		return requests.length === 1
			? structured
			: {
					stop_reason: "end_turn",
					content: [{ type: "text", text: "secret-nonce" }],
				};
	}, "secret-nonce");
	expect(result.ok).toBe(true);
	expect(JSON.stringify(requests[0])).not.toContain("secret-nonce");
	expect(requests[1].messages).toEqual([
		...(requests[0].messages as unknown[]),
		{ role: "assistant", content: structured.content },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call_1", content: "secret-nonce" },
			],
		},
	]);
	expect(requests[1].tool_choice).toEqual({ type: "none" });
});

test.each([
	{ ...structured, stop_reason: "end_turn" },
	{
		...structured,
		content: [{ ...structured.content[1], input: "health.txt" }],
	},
	{ ...structured, content: [{ ...structured.content[1], name: "wrong" }] },
	{ ...structured, content: [{ ...structured.content[1], id: "" }] },
	{ ...structured, content: [structured.content[1], structured.content[1]] },
])("malformed tool contract is rejected", async (reply) => {
	expect((await laneToolRoundtrip(async () => reply)).ok).toBe(false);
});

test("wrong result or unfinished assistant cannot pass", async () => {
	for (const reply of [
		{ stop_reason: "end_turn", content: [{ type: "text", text: "invented" }] },
		{ stop_reason: "max_tokens", content: [{ type: "text", text: "nonce" }] },
	]) {
		let count = 0;
		expect(
			(
				await laneToolRoundtrip(
					async () => (++count === 1 ? structured : reply),
					"nonce",
				)
			).ok,
		).toBe(false);
	}
});
