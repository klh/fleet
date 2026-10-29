// test/outbound-guard.test.ts — W1257.1 outbound guard unit contract: wire
// selection by ingress path, built-URL (post path_rewrite) matching, the
// per-wire correction leading the refusal message, and fail-closed config
// validation.
import { describe, expect, test } from "bun:test";
import {
	guardWireOfPath,
	outboundBlockOf,
	validateOutboundGuardConfig,
} from "../src/outbound-guard.ts";
import type { Deployment } from "../src/upstreams.ts";

const ZAI_BASE = "https://api.z.ai";

const CORRECTIONS = {
	anthropic: `${ZAI_BASE}/api/anthropic/v1/messages`,
	openai: `${ZAI_BASE}/api/coding/paas/v4/chat/completions`,
	responses: `${ZAI_BASE}/api/v1/responses`,
};

const depWith = (adapter_config: Record<string, unknown>): Deployment => ({
	url: ZAI_BASE,
	dialect: "openai",
	adapter: "openai-compat",
	group: "glm-5.3-flash",
	adapter_config,
});

const guardedDep = (): Deployment =>
	depWith({
		blocked_outbound: { paths: ["/api/paas/v4/"], corrections: CORRECTIONS },
	});

describe("guardWireOfPath", () => {
	test("ingress POST path decides the wire", () => {
		expect(guardWireOfPath("/v1/messages")).toBe("anthropic");
		expect(guardWireOfPath("/v1/messages/count_tokens")).toBe("anthropic");
		expect(guardWireOfPath("/v1/responses")).toBe("responses");
		expect(guardWireOfPath("/v1/chat/completions")).toBe("openai");
		// an unknown path rides the openai wire (the catch-all dialect)
		expect(guardWireOfPath("/v1/other")).toBe("openai");
	});
});

describe("outboundBlockOf", () => {
	test("blocks the built general-endpoint URL and names this wire's coding base", () => {
		const err = outboundBlockOf(
			guardedDep(),
			"/v1/chat/completions",
			`${ZAI_BASE}/api/paas/v4/chat/completions`,
		);
		expect(err?.builtUrl).toBe(`${ZAI_BASE}/api/paas/v4/chat/completions`);
		expect(err?.wire).toBe("openai");
		expect(err?.correction).toBe(CORRECTIONS.openai);
		// the message LEADS with this wire's destination, never another wire's
		expect(err?.message).toContain(
			`OpenAI Chat Completions requests belong on ${CORRECTIONS.openai}`,
		);
	});

	test("anthropic-wire traffic is never pointed at the OpenAI base", () => {
		const err = outboundBlockOf(
			guardedDep(),
			"/v1/messages",
			`${ZAI_BASE}/api/paas/v4/chat/completions`,
		);
		expect(err?.wire).toBe("anthropic");
		expect(err?.correction).toBe(CORRECTIONS.anthropic);
		expect(err?.message).toContain(
			`Anthropic Messages requests belong on ${CORRECTIONS.anthropic}`,
		);
		// the OpenAI coding base appears only as a labeled companion, never
		// as this wire's destination
		expect(err?.message).not.toContain(
			`requests belong on ${CORRECTIONS.openai}`,
		);
	});

	test("responses wire names the api/v1 base", () => {
		const err = outboundBlockOf(
			guardedDep(),
			"/v1/responses",
			`${ZAI_BASE}/api/paas/v4/chat/completions`,
		);
		expect(err?.wire).toBe("responses");
		expect(err?.correction).toBe(CORRECTIONS.responses);
		expect(err?.message).toContain(
			`OpenAI Responses requests belong on ${CORRECTIONS.responses}`,
		);
	});

	test("no config or non-matching built path proceeds (null)", () => {
		expect(
			outboundBlockOf(
				depWith({}),
				"/v1/chat/completions",
				`${ZAI_BASE}/api/paas/v4/chat/completions`,
			),
		).toBeNull();
		expect(
			outboundBlockOf(
				guardedDep(),
				"/v1/chat/completions",
				`${ZAI_BASE}/api/coding/paas/v4/chat/completions`,
			),
		).toBeNull();
	});

	test("typed error is a non-retryable bad_request RouterError", () => {
		const err = outboundBlockOf(
			guardedDep(),
			"/v1/chat/completions",
			`${ZAI_BASE}/api/paas/v4/chat/completions`,
		);
		expect(err?.kind).toBe("bad_request");
		expect(err?.retryable).toBe(false);
		expect(err?.status).toBe(400);
	});
});

describe("validateOutboundGuardConfig", () => {
	test("valid rows pass and absent config is inert", () => {
		expect(
			validateOutboundGuardConfig({
				blocked_outbound: {
					paths: ["/api/paas/v4/"],
					corrections: CORRECTIONS,
				},
			}),
		).toBeUndefined();
		expect(validateOutboundGuardConfig(undefined)).toBeUndefined();
		expect(validateOutboundGuardConfig({})).toBeUndefined();
	});

	test("malformed rows fail closed", () => {
		expect(() =>
			validateOutboundGuardConfig({ blocked_outbound: "no" }),
		).toThrow("must be an object");
		expect(() =>
			validateOutboundGuardConfig({ blocked_outbound: { corrections: {} } }),
		).toThrow("paths");
		expect(() =>
			validateOutboundGuardConfig({
				blocked_outbound: { paths: ["relative"], corrections: {} },
			}),
		).toThrow("paths");
		expect(() =>
			validateOutboundGuardConfig({
				blocked_outbound: { paths: ["/ok"], corrections: "no" },
			}),
		).toThrow("corrections");
		expect(() =>
			validateOutboundGuardConfig({
				blocked_outbound: { paths: ["/ok"], corrections: { zap: "https://x" } },
			}),
		).toThrow("anthropic|openai|responses");
		expect(() =>
			validateOutboundGuardConfig({
				blocked_outbound: {
					paths: ["/ok"],
					corrections: { openai: "not a url" },
				},
			}),
		).toThrow("absolute http(s) URL");
	});
});
