// review-leg-wire.e2e.ts — W2352: the review leg's wire demotion. A rung
// that answers with a FOREIGN model class is an identity liar — it can never
// yield a trusted verdict (W1302.6 graded the substituted PASS ERROR only
// after the full generation burned: W2317/W2308, 378s/250s each). The leg
// now throws a TERMINAL (non-transport) classification so walkLegs spends
// the rung and steps to the next; the error-body reason (spark rung's
// context-overflow 400, litellm.ContextWindowExceededError) rides the trail
// instead of a bare "HTTP 400".

import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { requestReviewLeg } from "../hooks/lib/gates/review-prompt.ts";
import {
	isTransportFailure,
	walkLegs,
} from "../hooks/lib/gates/review-quota.ts";

const URL_PATH = "/v1/chat/completions";
const noSleep = async (): Promise<void> => {};

test.describe("requestReviewLeg wire demotion", () => {
	test("foreign served model demotes the rung (terminal throw)", async () => {
		const stub = serveStub(() =>
			Response.json({
				model: "glm-5.2",
				choices: [{ message: { content: "VERDICT: PASS" } }],
			}),
		);
		try {
			const err = await requestReviewLeg({
				url: `${stub.url}${URL_PATH}`,
				model: "glm-4.5-air",
				prompt: "review",
				timeoutMs: 5000,
			}).catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe(
				"Review LLM wire-model mismatch: requested glm-4.5-air served glm-5.2",
			);
		} finally {
			stub.close();
		}
	});

	test("same-class served model rides (prefix + snapshot stamps)", async () => {
		const cases: [string, string][] = [
			["glm-5.3-flash", "zai-glm-5.3-flash"],
			["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
		];
		for (const [requested, served] of cases) {
			const stub = serveStub(() =>
				Response.json({
					model: served,
					choices: [{ message: { content: "VERDICT: PASS" } }],
				}),
			);
			try {
				const reply = await requestReviewLeg({
					url: `${stub.url}${URL_PATH}`,
					model: requested,
					prompt: "review",
					timeoutMs: 5000,
				});
				expect(reply.text).toContain("VERDICT: PASS");
			} finally {
				stub.close();
			}
		}
	});

	test("absent served-model stamp never demotes", async () => {
		const stub = serveStub(() =>
			Response.json({
				choices: [{ message: { content: "VERDICT: payload-absent" } }],
			}),
		);
		try {
			const reply = await requestReviewLeg({
				url: `${stub.url}${URL_PATH}`,
				model: "glm-5.3-flash",
				prompt: "review",
				timeoutMs: 5000,
			});
			expect(reply.text).toBe("VERDICT: payload-absent");
		} finally {
			stub.close();
		}
	});

	test("error-body reason rides the HTTP throw (context-overflow 400)", async () => {
		const stub = serveStub(() =>
			Response.json(
				{
					error: {
						message:
							"litellm.ContextWindowExceededError: Context window exceeded",
					},
				},
				{ status: 400 },
			),
		);
		try {
			const err = await requestReviewLeg({
				url: `${stub.url}${URL_PATH}`,
				model: "local-coder",
				prompt: "review",
				timeoutMs: 5_000,
			}).catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("Review LLM HTTP 400");
			expect((err as Error).message).toContain("ContextWindowExceededError");
		} finally {
			stub.close();
		}
	});

	test("error-body keys redact in the throw message", async () => {
		const stub = serveStub(() =>
			Response.json(
				{ error: { message: "bad key bksk_abc123DEF-xyz presented" } },
				{ status: 401 },
			),
		);
		try {
			const err = await requestReviewLeg({
				url: `${stub.url}${URL_PATH}`,
				model: "local-coder",
				prompt: "review",
				timeoutMs: 5_000,
			}).catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("[redacted]");
			expect((err as Error).message).not.toContain("bksk_abc123");
		} finally {
			stub.close();
		}
	});
});

test.describe("walkLegs demotion integration", () => {
	test("mismatch rung spent, walk lands the honest rung", async () => {
		const MISMATCH = new Error(
			"Review LLM wire-model mismatch: requested glm-4.5-air served glm-5.2",
		);
		const scripts: (string | Error)[][] = [[MISMATCH], ["VERDICT: PASS"]];
		const calls: { leg: number; attempt: number }[] = [];
		const request = async (legIndex: number, attempt: number) => {
			calls.push({ leg: legIndex, attempt });
			const next = scripts[legIndex]?.shift();
			if (next === undefined)
				throw new Error(`unexpected call leg=${legIndex} attempt=${attempt}`);
			if (next instanceof Error) throw next;
			return next;
		};
		const walk = await walkLegs({
			legLabels: ["glm-4.5-air", "local-coder"],
			request,
			satisfied: (text) => text.includes("VERDICT: PASS"),
			sleep: noSleep,
		});
		expect(walk.failure).toBeNull();
		expect(walk.texts).toEqual(["VERDICT: PASS"]);
		expect(walk.trail).toHaveLength(2);
		expect(walk.trail[0]?.ok).toBe(false);
		expect(walk.trail[0]?.error).toContain("wire-model mismatch");
		expect(walk.trail[1]?.ok).toBe(true);
	});
});

test.describe("isTransportFailure classification", () => {
	test("mismatch + enriched-400 messages stay terminal", () => {
		expect(
			isTransportFailure(
				"Review LLM wire-model mismatch: requested glm-4.5-air served glm-5.2",
			),
		).toBe(false);
		expect(
			isTransportFailure(
				"Review LLM HTTP 400: litellm.ContextWindowExceededError: x",
			),
		).toBe(false);
		expect(isTransportFailure("Review LLM HTTP 503: upstream busy")).toBe(true);
	});
});
