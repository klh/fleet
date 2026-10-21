import { describe, expect, test } from "bun:test";
import {
	requestAnthropicToOpenAI,
	requestOpenAIToAnthropic,
} from "../src/adapters/tools.ts";

// W1080 proxy law: buckle is a proxy — it echoes the wire. Unknown client
// fields pass through verbatim (upstreams own any objection); nothing in
// the request transform may reject a body for carrying an extra field.
describe("W1080 proxy law: unknown fields ride the bridge", () => {
	test("anthropic→openai passes unknown top-level fields through verbatim", () => {
		const t = requestAnthropicToOpenAI({
			model: "glm-5.3-flash",
			max_tokens: 16,
			context_management: {
				edits: [{ type: "clear_tool_uses_20250919" }],
			},
			service_tier: "auto",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(t.rejected).toBeNull();
		const body = t.body as Record<string, unknown>;
		expect(body.context_management).toEqual({
			edits: [{ type: "clear_tool_uses_20250919" }],
		});
		expect(body.service_tier).toBeUndefined(); // W1080 amendment: known-untranslatable drops
	});

	test("anthropic→openai drops untranslatable tool_choice instead of rejecting", () => {
		const t = requestAnthropicToOpenAI({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "banana" },
			messages: [],
		});
		expect(t.rejected).toBeNull();
		expect(t.body.tool_choice).toBeUndefined();
	});

	test("openai→anthropic passes unknown top-level fields through verbatim", () => {
		const t = requestOpenAIToAnthropic({
			model: "glm-5.3-flash",
			max_tokens: 16,
			wobble_field_x: true,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(t.rejected).toBeNull();
		expect(t.body.wobble_field_x).toBe(true);
	});
});
