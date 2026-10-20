import { describe, expect, test } from "bun:test";
import { chatGptSubscriptionRows } from "../bin/chatgpt-subscription-rows.ts";

describe("ChatGPT subscription model rows", () => {
	test("keeps a distinct subscription model group", () => {
		const rows = chatGptSubscriptionRows(["gpt-5.4", "gpt-5.4"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("model_name: chatgpt/gpt-5.4");
		expect(rows[0]).toContain("mode: responses");
		expect(rows[0]).toContain("model: chatgpt/gpt-5.4");
	});

	test("rejects YAML injection and malformed ids", () => {
		expect(() =>
			chatGptSubscriptionRows(["gpt-5.4\napi_key: stolen"]),
		).toThrow();
		expect(() => chatGptSubscriptionRows({ model: "gpt-5.4" })).toThrow();
	});
});
