// board-exec-llm.test.ts — W1119 caller-level evidence: board llm:* dispatch
// legs (llmRoute + localSwarmChat) ride ONE gated answer leg — the machine/
// model preference is W136 hint data ('prefer host:<machine> model:<id>' /
// 'prefer local model:<id>'), never a belt route-to shell or a direct
// :890x socket; a down gate or absent scoped key fails closed with the
// bounded error the caller lands as llm.error.
import { describe, expect, test } from "bun:test";
import { gatedLlmAnswer } from "../hooks/board/exec.ts";

const GATE_ENV = {
	SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_exec_test",
};

describe("gated llm:* answer leg (W1119)", () => {
	test("remote pick: auth + 'prefer host:<machine> model:<id>' ride the wire", async () => {
		let seen: { url: string; auth: string | null; hint: string | null } = {
			url: "",
			auth: null,
			hint: null,
		};
		let calls = 0;
		const answer = await gatedLlmAnswer({
			model: "qwen3-32b",
			prompt: "Summarize the diff.",
			hint: "prefer host:nas model:qwen3-32b",
			env: GATE_ENV,
			fetcher: (async (input: unknown, init?: RequestInit) => {
				calls++;
				const h = new Headers(init?.headers);
				seen = {
					url: String(input),
					auth: h.get("authorization"),
					hint: h.get("x-belt-hint"),
				};
				return Response.json({
					content: [{ type: "text", text: "The diff adds csv export." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
		expect(answer).toBe("The diff adds csv export.");
		expect(seen.url).toBe("http://127.0.0.1:4101/v1/messages");
		expect(seen.auth).toBe("Bearer bksk_exec_test");
		expect(seen.hint).toBe("prefer host:nas model:qwen3-32b");
	});
	test("local pick: 'prefer local model:<id>' rides the same wire", async () => {
		let hint: string | null = null;
		await gatedLlmAnswer({
			model: "local-coder",
			prompt: "Review the plan.",
			hint: "prefer local model:local-coder",
			env: GATE_ENV,
			fetcher: (async (_input: unknown, init?: RequestInit) => {
				hint = new Headers(init?.headers).get("x-belt-hint");
				return Response.json({
					content: [{ type: "text", text: "Plan looks sound." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(hint).toBe("prefer local model:local-coder");
	});
	test("down gate → bounded fail-closed error, no reroute leg", async () => {
		let calls = 0;
		await expect(
			gatedLlmAnswer({
				model: "qwen3-32b",
				prompt: "p",
				hint: "prefer host:nas model:qwen3-32b",
				env: {
					SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:1",
					SUSPENDERS_BUCKLE_TOKEN: "bksk_exec_test",
				},
				fetcher: (async () => {
					calls++;
					throw new Error("ECONNREFUSED");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("buckle inference unavailable");
		expect(calls).toBe(1); // exactly the gate leg
	});
	test("missing scoped key fails closed before any fetch", async () => {
		let calls = 0;
		await expect(
			gatedLlmAnswer({
				model: "qwen3-32b",
				prompt: "p",
				hint: "prefer local model:local-coder",
				env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" },
				fetcher: (async () => {
					calls++;
					return Response.json({ content: [] });
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("together");
		expect(calls).toBe(0);
	});
	test("gate refusal carries status + trace, never the upstream body", async () => {
		await expect(
			gatedLlmAnswer({
				model: "qwen3-32b",
				prompt: "p",
				hint: "prefer local model:local-coder",
				env: GATE_ENV,
				fetcher: (async () =>
					new Response('{"error":"prompt-and-key-echo upstream text"}', {
						status: 503,
						headers: { "x-klh-trace-id": "b".repeat(32) },
					})) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/HTTP 503 \(trace b{32}\)/);
	});
});
