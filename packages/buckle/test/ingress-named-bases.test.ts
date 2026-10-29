// test/ingress-named-bases.test.ts — W1265 named-base ingress e2e: the
// wire-named bases (/anthropic, /openai) + provider-pinned /zai/* variants,
// composed with the /w/<sid> lane prefix. Proves: right-wire round-trip
// (outbound rides the stub), wrong-wire / wrong-method typed local 4xx with
// ZERO outbound, provider pin scoping (non-zai candidates structurally
// unreachable; cross-dialect bridge refused), legacy bare /v1 preserved.
import { describe, expect, test } from "bun:test";
import { startMockUpstream, type MockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import { namedIngressOf, namedIngressGuard } from "../src/ingress-routes.ts";

const POST = (
	base: string,
	rest: string,
	model = "glm-5.3",
): Request =>
	new Request(`${base}${rest}`, {
		method: "POST",
		body: JSON.stringify({ model, stream: false }),
	});

const ANTHROPIC_REPLY = () =>
	Response.json({
		id: "msg_w1265",
		usage: { input_tokens: 5, output_tokens: 2 },
	});

const callsOf = (m: MockUpstream): number => m.calls.length;

const app = (url: string, adapter?: string): AppDeps =>
	testDeps({
		groups: () => ["glm-5.3"],
		deployments: (g) => [
			{
				group: g,
				url,
				dialect: "anthropic" as const,
				...(adapter === undefined ? {} : { adapter }),
			},
		],
	});

describe("W1265 parser", () => {
	test("named bases, provider pin, lane composition", () => {
		expect(namedIngressOf("/anthropic/v1/messages")).toEqual({
			lane: "",
			provider: null,
			wire: "anthropic",
			rest: "/v1/messages",
		});
		expect(namedIngressOf("/w/lane-7/zai/openai/v1/chat/completions")).toEqual({
			lane: "lane-7",
			provider: "zai",
			wire: "openai",
			rest: "/v1/chat/completions",
		});
		expect(namedIngressOf("/w/abc/v1/messages")).toBe(null); // legacy shape
		expect(namedIngressOf("/copilot/anthropic/v1/messages")).toBe(null);
		expect(namedIngressOf("/health")).toBe(null);
	});
});

describe("W1265 guard", () => {
	test("wrong wire → 404, wrong method → 405 (both local)", () => {
		const named = namedIngressOf("/anthropic/v1/chat/completions");
		const g2 = namedIngressOf("/openai/v1/responses");
		expect(named).not.toBe(null);
		expect(g2).not.toBe(null);
		if (named === null || g2 === null) return;
		const res = namedIngressGuard(named, "POST");
		expect(res?.status).toBe(404);
		const r2 = namedIngressGuard(g2, "GET");
		expect(r2?.status).toBe(405);
	});
});

describe("W1265 right wire", () => {
	test("/w/<lane>/anthropic round-trips, lane lands in audit", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY);
		const d = app(upstream.url, "zai");
		const appObj = createApp(d);
		const res = await appObj.fetch(
			POST(upstream.url, "/w/lane-7/anthropic/v1/messages"),
		);
		expect(res.status).toBe(200);
		expect(callsOf(upstream)).toBe(1);
		const audit = d.ledger.auditRows()[0] as { lane?: string } | undefined;
		expect(audit?.lane).toBe("lane-7");
		upstream.close();
	});
});

describe("W1265 wrong wire/method (zero outbound)", () => {
	test("/anthropic + openai path → 404 wire_mismatch, zero outbound", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY);
		const d = app(upstream.url, "zai");
		const appObj = createApp(d);
		const res = await appObj.fetch(
			POST(upstream.url, "/anthropic/v1/chat/completions"),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("buckle.wire_mismatch");
		expect(callsOf(upstream)).toBe(0);
		upstream.close();
	});

	test("GET /openai/v1/responses → 405, zero outbound", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY);
		const d = app(upstream.url, "zai");
		const appObj = createApp(d);
		const res = await appObj.fetch(
			new Request(`${upstream.url}/openai/v1/responses`),
		);
		expect(res.status).toBe(405);
		expect(callsOf(upstream)).toBe(0);
		upstream.close();
	});
});

describe("W1265 provider pin", () => {
	test("mixed pool: only the zai row can head (other stub zero calls)", async () => {
		const zaiStub = await startMockUpstream(ANTHROPIC_REPLY);
		const otherStub = await startMockUpstream(ANTHROPIC_REPLY);
		const d = testDeps({
			groups: () => ["glm-5.3"],
			deployments: (g) => [
				{ group: g, url: otherStub.url, dialect: "anthropic" as const },
				{
					group: "glm-5.3",
					url: zaiStub.url,
					dialect: "anthropic" as const,
					adapter: "zai",
				},
			],
		});
		const appObj = createApp(d);
		const res = await appObj.fetch(
			POST(zaiStub.url, "/zai/anthropic/v1/messages"),
		);
		expect(res.status).toBe(200);
		expect(callsOf(zaiStub)).toBe(1);
		expect(callsOf(otherStub)).toBe(0);
		zaiStub.close();
		otherStub.close();
	});

	test("no zai row → 503 typed refusal, zero outbound", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY); // no adapter
		const d = app(upstream.url); // adapter undefined
		const appObj = createApp(d);
		const res = await appObj.fetch(
			POST(upstream.url, "/zai/anthropic/v1/messages"),
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { why?: string; code?: string };
		expect(body.code).toBe("no_route");
		expect(body.why).toContain("provider pin 'zai'");
		expect(callsOf(upstream)).toBe(0);
		upstream.close();
	});

	test("pinned route never bridges dialects", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY);
		const d = app(upstream.url, "zai");
		const appObj = createApp(d);
		const res = await appObj.fetch(
			POST(upstream.url, "/zai/openai/v1/chat/completions"),
		);
		expect(res.status).toBe(503);
		expect(callsOf(upstream)).toBe(0);
		upstream.close();
	});
});

describe("W1265 legacy preserved", () => {
	test("bare /v1/messages and /w/<lane>/v1/messages still route", async () => {
		const upstream = await startMockUpstream(ANTHROPIC_REPLY);
		const d = app(upstream.url, "zai");
		const appObj = createApp(d);
		const r1 = await appObj.fetch(POST(upstream.url, "/v1/messages"));
		expect(r1.status).toBe(200);
		const r2 = await appObj.fetch(
			POST(upstream.url, "/w/lane-7/v1/messages"),
		);
		expect(r2.status).toBe(200);
		expect(callsOf(upstream)).toBe(2);
		upstream.close();
	});
});
