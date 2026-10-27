// review-quota.test.ts — W1313 quota-aware review-leg walk: transport
// failures (HTTP 429/504) back off and retry, a sustained wall walks the
// secondary reviewer model, terminal failures walk immediately, and the
// trail records every attempt for the receipt.

import { expect, test } from "@playwright/test";
import {
	type WalkOptions,
	defaultBackoffMs,
	isTransportFailure,
	parseFallbackModels,
	renderTrail,
	walkLegs,
} from "../hooks/lib/gates/review-quota.ts";

const VERDICT = "VERDICT: PASS";

/** Stub request sequencer: each leg gets its own throw/reply script. */
function stubSequencer(scripts: Record<string, (string | Error)[]>) {
	const calls: { leg: number; attempt: number }[] = [];
	const request: (legIndex: number, attempt: number) => Promise<string> = (
		legIndex,
		attempt,
	) => {
		calls.push({ leg: legIndex, attempt });
		const script = scripts[String(legIndex)] ?? [];
		const next = script.shift();
		if (next === undefined)
			throw new Error(`unexpected call leg=${legIndex} attempt=${attempt}`);
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve(next);
	};
	return { calls, request };
}

const noSleep: NonNullable<WalkOptions["sleep"]> = async () => {};

test.describe("isTransportFailure", () => {
	test("429/408/5xx are transport failures", () => {
		expect(isTransportFailure("Review LLM HTTP 429")).toBe(true);
		expect(isTransportFailure("Review LLM HTTP 504")).toBe(true);
		expect(isTransportFailure("Review LLM HTTP 408")).toBe(true);
	});
	test("client errors are terminal", () => {
		expect(isTransportFailure("Review LLM HTTP 400")).toBe(false);
		expect(isTransportFailure("Review LLM HTTP 401")).toBe(false);
		expect(isTransportFailure("Review LLM HTTP 404")).toBe(false);
	});
	test("timeouts and connection drops are transport failures", () => {
		expect(isTransportFailure("The operation timed out.")).toBe(true);
		expect(isTransportFailure("fetch failed")).toBe(true);
		expect(isTransportFailure("connection ECONNRESET")).toBe(true);
	});
});

test.describe("defaultBackoffMs", () => {
	test("2s doubling capped at 8s", () => {
		expect(defaultBackoffMs(0, 1)).toBe(2000);
		expect(defaultBackoffMs(0, 2)).toBe(4000);
		expect(defaultBackoffMs(1, 3)).toBe(8000);
		expect(defaultBackoffMs(2, 9)).toBe(8000);
	});
});

test.describe("parseFallbackModels", () => {
	test("CSV split, trimmed, empties dropped, undefined = none", () => {
		expect(parseFallbackModels("a, b ,,c")).toEqual(["a", "b", "c"]);
		expect(parseFallbackModels(undefined)).toEqual([]);
		expect(parseFallbackModels("")).toEqual([]);
	});
});

test.describe("walkLegs", () => {
	test("429-then-200 on the primary: retry succeeds, trail carries both", async () => {
		const stub = stubSequencer({
			"0": [new Error("Review LLM HTTP 429"), `findings\n${VERDICT}`],
		});
		const sleeps: number[] = [];
		const walk = await walkLegs({
			legLabels: ["glm-5.3-flash"],
			request: stub.request,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		expect(walk.texts).toEqual([`findings\n${VERDICT}`]);
		expect(walk.failure).toBeNull();
		expect(stub.calls).toEqual([
			{ leg: 0, attempt: 1 },
			{ leg: 0, attempt: 2 },
		]);
		expect(sleeps).toEqual([2000]);
		expect(walk.trail).toEqual([
			{
				leg: "glm-5.3-flash",
				attempt: 1,
				ok: false,
				error: "Review LLM HTTP 429",
				ms: expect.any(Number),
			},
			{
				leg: "glm-5.3-flash",
				attempt: 2,
				ok: true,
				ms: expect.any(Number),
			},
		]);
	});

	test("sustained 429 wall walks the secondary model", async () => {
		const stub = stubSequencer({
			"0": [
				new Error("Review LLM HTTP 429"),
				new Error("Review LLM HTTP 429"),
				new Error("Review LLM HTTP 429"),
			],
			"1": [`secondary findings\n${VERDICT}`],
		});
		const walk = await walkLegs({
			legLabels: ["glm-5.3-flash", "glm-5.3"],
			request: stub.request,
			sleep: noSleep,
		});
		expect(walk.texts).toEqual([`secondary findings\n${VERDICT}`]);
		expect(stub.calls).toEqual([
			{ leg: 0, attempt: 1 },
			{ leg: 0, attempt: 2 },
			{ leg: 0, attempt: 3 },
			{ leg: 1, attempt: 1 },
		]);
		expect(walk.trail.at(-2)?.leg).toBe("glm-5.3-flash");
		expect(walk.trail.at(-1)?.leg).toBe("glm-5.3");
	});

	test("terminal failure (HTTP 401) skips the remaining retries", async () => {
		const stub = stubSequencer({
			"0": [new Error("Review LLM HTTP 401")],
			"1": [`${VERDICT}`],
		});
		const sleeps: number[] = [];
		const walk = await walkLegs({
			legLabels: ["primary", "secondary"],
			request: stub.request,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		expect(stub.calls).toEqual([
			{ leg: 0, attempt: 1 },
			{ leg: 1, attempt: 1 },
		]);
		expect(sleeps).toEqual([]);
		expect(walk.failure).toBeNull();
	});

	test("all legs exhausted: failure carried, no texts", async () => {
		const stub = stubSequencer({
			"0": [new Error("Review LLM HTTP 504"), new Error("Review LLM HTTP 504")],
			"1": [new Error("Review LLM HTTP 429"), new Error("Review LLM HTTP 429")],
		});
		const walk = await walkLegs({
			legLabels: ["a", "b"],
			attemptsPerLeg: 2,
			request: stub.request,
			sleep: noSleep,
		});
		expect(walk.texts).toEqual([]);
		expect(walk.failure).toBe("Review LLM HTTP 429");
		expect(walk.trail).toHaveLength(4);
	});

	test("unsatisfied reply (no verdict line): one same-leg retry, then walk", async () => {
		const stub = stubSequencer({
			// W1236 parity: two bounded tries on the leg before walking
			"0": ["prose without a verdict", "still no verdict"],
			"1": [`${VERDICT}`],
		});
		const sleeps: number[] = [];
		const walk = await walkLegs({
			legLabels: ["a", "b"],
			request: stub.request,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
			satisfied: (text) => text.includes("VERDICT:"),
		});
		expect(stub.calls).toEqual([
			{ leg: 0, attempt: 1 },
			{ leg: 0, attempt: 2 },
			{ leg: 1, attempt: 1 },
		]);
		expect(sleeps).toEqual([20_000]);
		expect(walk.texts).toEqual([
			"prose without a verdict",
			"still no verdict",
			VERDICT,
		]);
		// satisfied on the next leg — the walk's final state is success
		expect(walk.failure).toBeNull();
	});
});

test.describe("renderTrail", () => {
	test("compact arrow form with wall time", () => {
		expect(
			renderTrail({
				trail: [
					{
						leg: "glm-5.3-flash",
						attempt: 1,
						ok: false,
						error: "Review LLM HTTP 429",
						ms: 120,
					},
					{
						leg: "glm-5.3-flash",
						attempt: 2,
						ok: true,
						ms: 33_400,
					},
				],
				totalMs: 33_520,
			}),
		).toBe(
			"trail: glm-5.3-flash#1:Review LLM HTTP 429 -> glm-5.3-flash#2:ok (33.5s)",
		);
	});
});
