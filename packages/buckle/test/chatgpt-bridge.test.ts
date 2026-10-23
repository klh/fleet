// test/chatgpt-bridge.test.ts — W1124.27 instruction-plan unit contract:
// leading string system/developer passes through (roles/order unchanged),
// leading pure-text-block content flattens textually, mid-turn
// system/developer and non-text instruction content TYPED-REFUSE the hop
// (the backend offers no system-class input slot — live probes 2026-10-23:
// leading string 200, leading block 400, mid-turn 400, mid-turn developer
// 400, leading developer 200, tools canary 200).
import { describe, expect, test } from "bun:test";
import {
	chatgptInstructionPlan,
	chatgptSafeBody,
	isChatgptGroupModel,
} from "../src/chatgpt-bridge.ts";

describe("chatgpt-bridge instruction plan", () => {
	test("passthrough: leading string system, zero rewrites", () => {
		const messages = [
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hi" },
		];
		const plan = chatgptInstructionPlan(messages);
		expect(plan.kind).toBe("passthrough");
	});

	test("flattens leading pure-text-block system to string", () => {
		const plan = chatgptInstructionPlan([
			{
				role: "system",
				content: [{ type: "text", text: "be brief" }],
			},
			{ role: "user", content: "hi" },
		]);
		expect(plan.kind).toBe("normalize");
		if (plan.kind !== "normalize") return;
		expect(plan.flattened).toBe(1);
		expect(plan.messages).toEqual([
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hi" },
		]);
	});

	test("typed-refuses mid-turn system (no native equivalent)", () => {
		const plan = chatgptInstructionPlan([
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hi" },
			{ role: "system", content: "new rule" },
			{ role: "user", content: "again" },
		]);
		expect(plan).toEqual({ kind: "refuse", reason: "mid-turn-instruction" });
	});

	test("typed-refuses mid-turn developer likewise", () => {
		const plan = chatgptInstructionPlan([
			{ role: "user", content: "hi" },
			{ role: "developer", content: "new rule" },
			{ role: "assistant", content: "hello" },
		]);
		expect(plan).toEqual({ kind: "refuse", reason: "mid-turn-instruction" });
	});

	test("keeps multiple leading systems in order and flattens blocks", () => {
		const plan = chatgptInstructionPlan([
			{ role: "system", content: "first" },
			{
				role: "developer",
				content: [{ type: "text", text: "second" }],
			},
			{ role: "user", content: "hi" },
		]);
		expect(plan.kind).toBe("normalize");
		if (plan.kind !== "normalize") return;
		expect(plan.flattened).toBe(1);
		expect(plan.messages).toEqual([
			{ role: "system", content: "first" },
			{ role: "developer", content: "second" },
			{ role: "user", content: "hi" },
		]);
	});

	test("typed-refuses non-text instruction content (never flatten blind)", () => {
		const plan = chatgptInstructionPlan([
			{
				role: "system",
				content: [{ type: "image_url", image_url: { url: "x" } }],
			},
			{ role: "user", content: "hi" },
		]);
		expect(plan).toEqual({
			kind: "refuse",
			reason: "non-text-instruction-content",
		});
	});

	test("input array is never mutated", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "system",
				content: [{ type: "text", text: "mid rule" }],
			},
		];
		const snapshot = structuredClone(messages);
		chatgptInstructionPlan(messages);
		expect(messages).toEqual(snapshot);
	});
});

describe("chatgpt-bridge body + group detection", () => {
	test("chatgptSafeBody: passthrough same ref, normalize new body, refuse null", () => {
		const clean = {
			model: "m",
			messages: [
				{ role: "system", content: "ok" },
				{ role: "user", content: "hi" },
			],
		};
		const dirty = {
			model: "m",
			messages: [{ role: "system", content: [{ type: "text", text: "x" }] }],
		};
		const unsafe = {
			model: "m",
			messages: [
				{ role: "system", content: "ok" },
				{ role: "user", content: "hi" },
				{ role: "system", content: "late rule" },
			],
		};
		expect(chatgptSafeBody(clean)).toBe(clean);
		expect(chatgptSafeBody(dirty)).not.toBe(dirty);
		expect(chatgptSafeBody(unsafe)).toBeNull();
	});

	test("isChatgptGroupModel matches the native provider prefix only", () => {
		expect(isChatgptGroupModel("chatgpt/gpt-6-sol")).toBe(true);
		expect(isChatgptGroupModel("gpt-6-sol")).toBe(false);
		expect(isChatgptGroupModel(undefined)).toBe(false);
	});
});

test.each([
	[
		"developer then system",
		[
			{ role: "developer", content: "A" },
			{ role: "system", content: "B" },
			{ role: "user", content: "hello" },
		],
	],
	[
		"system/developer/system",
		[
			{ role: "system", content: "A" },
			{ role: "developer", content: "B" },
			{ role: "system", content: "C" },
			{ role: "user", content: "hello" },
		],
	],
])("refuses %s without changing instruction chronology", (_name, messages) => {
	const before = structuredClone(messages);
	expect(chatgptInstructionPlan(messages)).toEqual({
		kind: "refuse",
		reason: "system-after-developer",
	});
	expect(messages).toEqual(before);
});

test("all-system input refuses the native connector's system-input fallback", () => {
	expect(chatgptInstructionPlan([{ role: "system", content: "A" }])).toEqual({
		kind: "refuse",
		reason: "system-only-input",
	});
	expect(
		chatgptInstructionPlan([
			{ role: "system", content: [{ type: "text", text: "A" }] },
		]),
	).toEqual({ kind: "refuse", reason: "system-only-input" });
});

test("supported leading system/developer run preserves all tool turns and definitions", () => {
	const tail = [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call1",
					type: "function",
					function: { name: "lookup", arguments: '{"q":"x"}' },
				},
			],
		},
		{ role: "tool", tool_call_id: "call1", content: "result" },
	];
	const tools = [
		{
			type: "function",
			function: { name: "lookup", parameters: { type: "object" } },
		},
	];
	const body = {
		messages: [
			{ role: "system", content: [{ type: "text", text: "A" }] },
			{ role: "developer", content: "B" },
			...tail,
		],
		tools,
	};
	const normalized = chatgptSafeBody(body);
	expect(normalized?.messages).toEqual([
		{ role: "system", content: "A" },
		{ role: "developer", content: "B" },
		...tail,
	]);
	expect(normalized?.tools).toBe(tools);
	expect((normalized?.messages as unknown[])?.slice(2)).toEqual(tail);
});
