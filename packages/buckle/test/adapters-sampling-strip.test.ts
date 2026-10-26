// test/adapters-sampling-strip.test.ts — W1142: the Anthropic 2026-10-21
// Messages wire returns 400 when a request carries temperature/top_p/top_k,
// even at default values (docs.anthropic.com /en/api/migration-2026-10-21).
// Rows declare their wire via adapter_config (pinned anthropic-version header
// or strip_sampling_params); the strip lives in ANTHROPIC.buildCall so both
// the same-dialect pass-through and the o→a bridged hop are covered.
import { describe, expect, test } from "bun:test";
import { bridgeRequest } from "../src/bridge.ts";
import { ANTHROPIC } from "../src/adapters/anthropic.ts";
import {
	requestAnthropicToOpenAI,
	requestOpenAIToAnthropic,
} from "../src/adapters/tools.ts";

const REQ = {
	group: "g",
	dialect: "anthropic" as const,
	path: "/v1/messages",
	body: {},
	key: "",
};

const BODY = {
	model: "claude-sonnet-5",
	max_tokens: 8,
	temperature: 0.5,
	top_p: 0.9,
	top_k: 40,
	messages: [{ role: "user", content: "ok" }],
};

const SAMPLES: [string, Record<string, unknown>][] = [
	[
		"version-pinned 2026-10-21",
		{ headers: { "anthropic-version": "2026-10-21" } },
	],
	["explicit strip_sampling_params", { strip_sampling_params: true }],
];

describe("sampling-param strip (W1142)", () => {
	test.each(SAMPLES)(
		"%s loses temperature/top_p/top_k, keeps the rest",
		async (_name, cfg) => {
			const dep = {
				group: "g",
				url: "https://api.anthropic.com",
				dialect: "anthropic" as const,
				adapter_config: cfg,
			};
			const wire = await ANTHROPIC.buildCall(dep, REQ, BODY);
			const parsed = JSON.parse(wire.body);
			expect(parsed.temperature).toBeUndefined();
			expect(parsed.top_p).toBeUndefined();
			expect(parsed.top_k).toBeUndefined();
			expect(parsed.max_tokens).toBe(8);
			expect(parsed.messages).toEqual(BODY.messages);
		},
	);

	test("version pin rides the wire headers", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
			adapter_config: { headers: { "anthropic-version": "2026-10-21" } },
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, BODY);
		expect(wire.headers["anthropic-version"]).toBe("2026-10-21");
	});

	test("unpinned rows keep today's verbatim forward (copilot et al.)", async () => {
		const dep = {
			group: "g",
			url: "https://api.githubcopilot.com",
			dialect: "anthropic" as const,
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, BODY);
		const parsed = JSON.parse(wire.body);
		expect(parsed.temperature).toBe(0.5);
		expect(parsed.top_p).toBe(0.9);
		expect(parsed.top_k).toBe(40);
	});

	test("old-version pin (2023-06-01) keeps the params", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
			adapter_config: { headers: { "anthropic-version": "2023-06-01" } },
		};
		const wire = await ANTHROPIC.buildCall(dep, REQ, BODY);
		const parsed = JSON.parse(wire.body);
		expect(parsed.temperature).toBe(0.5);
		expect(parsed.top_k).toBe(40);
	});

	test("o→a bridge hop into a pinned row loses all three (no hard 400)", async () => {
		const dep = {
			group: "g",
			url: "https://api.anthropic.com",
			dialect: "anthropic" as const,
			adapter_config: { headers: { "anthropic-version": "2026-10-21" } },
		};
		const req = {
			group: "g",
			dialect: "openai" as const,
			path: "/v1/chat/completions",
			body: { ...BODY },
			key: "",
		};
		const bridged = bridgeRequest(req, dep);
		if (!bridged) throw new Error("o→a hop must be eligible");
		const t = requestOpenAIToAnthropic(bridged.body);
		expect(t.rejected).toBeNull();
		const wire = await ANTHROPIC.buildCall(dep, REQ, t.body);
		const parsed = JSON.parse(wire.body);
		expect(parsed.temperature).toBeUndefined();
		expect(parsed.top_p).toBeUndefined();
		expect(parsed.top_k).toBeUndefined();
	});

	test("a→o bridge still forwards temperature/top_p (z.ai accepts; probe 2026-10-22)", () => {
		const t = requestAnthropicToOpenAI(BODY);
		expect(t.rejected).toBeNull();
		expect(t.body.temperature).toBe(0.5);
		expect(t.body.top_p).toBe(0.9);
		// top_k stays an honest degrade on the openai wire
		expect(t.body.top_k).toBeUndefined();
	});
});
