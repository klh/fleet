// test/prompt-bench-client.test.ts — W1119.2: the gated bench leg contract —
// one buckleChat call (anthropic wire), honest failure notes, <think> strip,
// served-model passthrough, fail-closed route resolution.
import { describe, expect, test } from "bun:test";
import { callGate, stripThink } from "../scripts/lib/prompt-bench-client.ts";

const GATE_ENV = {
	SUSPENDERS_BUCKLE_URL: "http://gate.test",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_bench_test",
};

const okFetcher =
	(body: unknown, status = 200) =>
	async (): Promise<Response> =>
		new Response(JSON.stringify(body), { status });

describe("callGate (W1119.2)", () => {
	test("ok leg: stripped text + served model passthrough", async () => {
		const r = await callGate(
			{
				model: "local-coder",
				system: "sys",
				user: "u",
				nonce: "n1",
				fetcher: okFetcher({
					content: [{ type: "text", text: "out <think>x</think>" }],
					model: "served-model",
				}),
			},
			GATE_ENV,
		);
		expect(r.ok).toBe(true);
		expect(r.note).toBe("ok");
		expect(r.text).toBe("out");
		expect(r.servedModel).toBe("served-model");
	});

	test("empty reply = honest empty note, served model kept", async () => {
		const r = await callGate(
			{
				model: "m",
				system: "s",
				user: "u",
				nonce: "n",
				fetcher: okFetcher({
					content: [{ type: "text", text: "<think>only</think>" }],
				}),
			},
			GATE_ENV,
		);
		expect(r.ok).toBe(false);
		expect(r.note).toBe("empty");
		expect(r.servedModel).toBe("m");
	});

	test("gate HTTP 500 = gate-failed note", async () => {
		const r = await callGate(
			{
				model: "m",
				system: "s",
				user: "u",
				nonce: "n",
				fetcher: okFetcher({}, 500),
			},
			GATE_ENV,
		);
		expect(r.ok).toBe(false);
		expect(r.note).toContain("gate failed");
		expect(r.note).toContain("HTTP 500");
	});

	test("missing buckle route = gate-failed note (fail-closed)", async () => {
		const r = await callGate(
			{ model: "m", system: "s", user: "u", nonce: "n" },
			{ SUSPENDERS_BUCKLE_URL: "http://gate.test" },
		);
		expect(r.ok).toBe(false);
		expect(r.note).toContain("gate failed");
		expect(r.note).toContain("configured together");
	});
});

describe("stripThink", () => {
	test("strips think blocks and trims", () => {
		expect(stripThink("a <think>junk</think> b")).toBe("a  b");
	});
});
