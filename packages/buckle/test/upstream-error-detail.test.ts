import { expect, test } from "bun:test";
import {
	normalizeUpstreamError,
	routerErrorEnvelope,
	upstreamErrorDetail,
} from "../src/adapters/errors.ts";
import {
	AnthropicToOpenAIStream,
	OpenAIToAnthropicStream,
} from "../src/adapters/tools.ts";

const trace = "1234567890abcdef1234567890abcdef";
const wire = {
	trace_id: trace,
	error: {
		type: "rate_limit_error",
		code: 1302,
		detail: "account concurrency exhausted",
	},
};

test("nested RFC problem cause, provider code and trace survive HTTP normalization", () => {
	const normalized = normalizeUpstreamError("anthropic", 429, wire);
	expect(normalized.message).toBe("account concurrency exhausted");
	expect(routerErrorEnvelope(normalized, "anthropic")).toEqual({
		type: "error",
		error: {
			type: "rate_limit_error",
			code: 1302,
			message: "account concurrency exhausted",
			trace_id: trace,
		},
	});
	expect(
		upstreamErrorDetail({
			type: "https://example.invalid/problem",
			title: "generic",
			why: "specific cause",
		}).message,
	).toBe("specific cause");
	expect(
		upstreamErrorDetail({ error: { detail: "nested detail" } }).message,
	).toBe("nested detail");
});

test("OpenAI to Anthropic SSE preserves provider failure context", () => {
	const stream = new OpenAIToAnthropicStream();
	const events = stream.push(wire);
	expect(events[0].data).toEqual({
		type: "error",
		error: upstreamErrorDetail(wire),
	});
	expect(stream.flush().some((event) => event.event === "message_stop")).toBe(
		false,
	);
});

test("Anthropic to OpenAI SSE preserves provider failure context", () => {
	const stream = new AnthropicToOpenAIStream();
	const events = stream.push({
		event: "error",
		data: { type: "error", ...wire },
	});
	expect(events[0].error).toEqual(upstreamErrorDetail(wire));
	expect(
		stream
			.flush()
			.some(
				(event) =>
					Array.isArray(event.choices) &&
					event.choices.some(
						(choice: { finish_reason?: string }) =>
							choice.finish_reason === "stop",
					),
			),
	).toBe(false);
});

test("extraction is bounded and scrubs credentials and home paths", () => {
	const fixtureHome = ["", "Users", "fixture"].join("/");
	const detail = upstreamErrorDetail({
		error: {
			message:
				`${fixtureHome}/file Bearer secret-token sk-fixturetoken ` +
				"x".repeat(5000),
			arbitrary_secret: "must not propagate",
		},
	});
	expect(detail.message.length).toBeLessThanOrEqual(1024);
	expect(detail.message).not.toContain("secret-token");
	expect(detail.message).not.toContain("sk-fixturetoken");
	expect(detail.message).not.toContain(fixtureHome);
	expect(Object.keys(detail).sort()).toEqual(["message", "type"]);
	const cycle: Record<string, unknown> = {};
	cycle.error = cycle;
	expect(upstreamErrorDetail(cycle).message).toBe("upstream stream error");
});
