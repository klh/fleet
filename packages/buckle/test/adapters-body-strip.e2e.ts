// test/adapters-body-strip.e2e.ts — W2594: per-row wire-body deny list.
// The hub's Copilot claude rows are DIRECT api.githubcopilot.com legs and
// Copilot 400s these anthropic-dialect body fields (isolation probe
// 2026-11-03): thinking (any form incl disabled), anthropic_beta (body
// field), parallel_tool_calls, mcp_servers, reasoning_effort, effort. Rows
// list them in adapter_config.strip_body_fields; ANTHROPIC.buildCall
// deletes those top-level keys after stripRemovedSampling. Absent/empty
// list = byte-identical verbatim forward.
import { expect, test } from "@playwright/test";
import { ANTHROPIC } from "../src/adapters/anthropic.ts";

test.describe("@unit", () => {
	const REQ = {
		group: "g",
		dialect: "anthropic" as const,
		path: "/v1/messages",
		body: {},
		key: "",
	};

	// the lane-shape body: dispatch injects effort envs unconditionally, so
	// thinking + reasoning_effort + anthropic_beta ride every claude lane leg
	const LANE_BODY = {
		model: "claude-sonnet-5",
		max_tokens: 8,
		thinking: { type: "disabled" },
		reasoning_effort: "low",
		anthropic_beta: ["context-management-2025-06-27"],
		parallel_tool_calls: true,
		mcp_servers: [{ type: "url", url: "https://m.local/sse" }],
		messages: [{ role: "user", content: "ok" }],
	};

	test("row with strip_body_fields forwards without the listed keys", async () => {
		const dep = {
			group: "g",
			url: "https://api.githubcopilot.com",
			dialect: "anthropic" as const,
			adapter_config: {
				strip_body_fields: [
					"thinking",
					"anthropic_beta",
					"parallel_tool_calls",
					"mcp_servers",
					"reasoning_effort",
					"effort",
				],
			},
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, LANE_BODY);
		const parsed = JSON.parse(wire.body);
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.anthropic_beta).toBeUndefined();
		expect(parsed.parallel_tool_calls).toBeUndefined();
		expect(parsed.mcp_servers).toBeUndefined();
		expect(parsed.reasoning_effort).toBeUndefined();
		expect(parsed.max_tokens).toBe(8);
		expect(parsed.messages).toEqual(LANE_BODY.messages);
	});

	test("row without the knob forwards verbatim", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, LANE_BODY);
		const parsed = JSON.parse(wire.body);
		expect(parsed.thinking).toEqual(LANE_BODY.thinking);
		expect(parsed.reasoning_effort).toBe("low");
		expect(parsed.anthropic_beta).toEqual(LANE_BODY.anthropic_beta);
		expect(parsed.parallel_tool_calls).toBe(true);
		expect(parsed.mcp_servers).toEqual(LANE_BODY.mcp_servers);
	});

	test("empty strip_body_fields list = no-op (verbatim)", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
			adapter_config: { strip_body_fields: [] },
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, LANE_BODY);
		const parsed = JSON.parse(wire.body);
		expect(parsed.thinking).toEqual(LANE_BODY.thinking);
		expect(parsed.reasoning_effort).toBe("low");
	});

	test("strip_body_fields composes with the sampling strip (both fire)", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
			adapter_config: {
				strip_sampling_params: true,
				strip_body_fields: ["thinking", "reasoning_effort"],
			},
		};
		const body = {
			...LANE_BODY,
			temperature: 0.5,
			top_p: 0.9,
			top_k: 40,
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, body);
		const parsed = JSON.parse(wire.body);
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.reasoning_effort).toBeUndefined();
		expect(parsed.temperature).toBeUndefined();
		expect(parsed.top_p).toBeUndefined();
		expect(parsed.top_k).toBeUndefined();
		expect(parsed.max_tokens).toBe(8);
	});
});
