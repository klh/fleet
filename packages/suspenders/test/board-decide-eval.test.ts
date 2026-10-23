// board-decide-eval.test.ts — W1119 caller-level evidence: the decision
// re-evaluation leg enters the shared Buckle client (authenticated
// /v1/messages, hint 'prefer local reasoning'), fails closed when the gate
// is unavailable or the scoped key is absent, and never touches the retired
// direct SUSPENDERS_LLM_URL leg.
import { describe, expect, test } from "bun:test";
import {
	EVAL_HINT,
	evalModel,
	gatedEval,
} from "../hooks/board/decide-eval.ts";

// W1119 stub credential pair — the knowledge-buckle contract both-or-neither
const GATE_ENV = {
	SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_eval_test",
};

describe("eval model preference (W1119 data, not endpoints)", () => {
	test("board settings pin wins", () => {
		expect(
			evalModel({ settings: { recommendation_model: "local-coder" } }),
		).toBe("local-coder");
	});
	test("SUSPENDERS_LLM_MODEL env pin next", () => {
		expect(
			evalModel({ env: { SUSPENDERS_LLM_MODEL: "glm-5.3-flash" } }),
		).toBe("glm-5.3-flash");
	});
	test("default is the reasoning preference id — no discovery probe", () => {
		expect(evalModel({})).toBe("local-reason");
	});
});

describe("gated evaluation leg (W1119)", () => {
	test("routes via the gate: auth, hint, model ride the wire", async () => {
		let seen: { url: string; auth: string | null; hint: string | null } = {
			url: "",
			auth: null,
			hint: null,
		};
		let calls = 0;
		const text = await gatedEval("Evaluate this decision.", {
			model: "local-reason",
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
					content: [
						{ type: "text", text: "Option A is safer — recommend A." },
					],
				});
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
		expect(text).toBe("Option A is safer — recommend A.");
		expect(seen.url).toBe("http://127.0.0.1:4101/v1/messages");
		expect(seen.auth).toBe("Bearer bksk_eval_test");
		expect(seen.hint).toBe(EVAL_HINT);
	});

	test("gate unavailable → throws fail-closed, no direct-leg reroute", async () => {
		let calls = 0;
		await expect(
			gatedEval("Evaluate.", {
				model: "local-reason",
				env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:1", SUSPENDERS_BUCKLE_TOKEN: "bksk_eval_test" },
				fetcher: (async () => {
					calls++;
					throw new Error("ECONNREFUSED");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("buckle inference unavailable");
		expect(calls).toBe(1); // exactly the gate leg — no 890x fallback
	});

	test("missing scoped key fails closed before any fetch", async () => {
		let calls = 0;
		await expect(
			gatedEval("Evaluate.", {
				model: "local-reason",
				env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" },
				fetcher: (async () => {
					calls++;
					return Response.json({ content: [] });
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("together");
		expect(calls).toBe(0);
	});

	test("gate refusal (HTTP 500) carries status + trace, never the body", async () => {
		await expect(
			gatedEval("Evaluate.", {
				model: "local-reason",
				env: GATE_ENV,
				fetcher: (async () =>
					new Response('{"error":"prompt-and-key-echo upstream text"}', {
						status: 500,
						headers: { "x-klh-trace-id": "a".repeat(32) },
					})) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/HTTP 500 \(trace a{32}\)/);
		await expect(
			gatedEval("Evaluate.", {
				model: "local-reason",
				env: GATE_ENV,
				fetcher: (async () =>
					new Response('{"error":"prompt-and-key-echo upstream text"}', {
						status: 500,
					})) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/HTTP 500 \(trace none\)/);
	});

	test("empty gate text → honest no-text error, never a placeholder eval", async () => {
		await expect(
			gatedEval("Evaluate.", {
				model: "local-reason",
				env: GATE_ENV,
				fetcher: (async () =>
					Response.json({
						content: [{ type: "text", text: "   " }],
					})) as unknown as typeof fetch,
			}),
		).rejects.toThrow("eval gate returned no text");
	});
});
