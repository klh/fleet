// w422-17-3-escalate.test.ts — W422.17.3: the :4000 router's cloud-escalation
// leg rides the buckle gate when the operator sets BELT_ESCALATE_URL/KEY
// (scoped buckle:proxy:WRITE_ key), and disables when not enrolled. Stub fetchers
// only — never the live :890x fleet, never real creds.
import { describe, expect, test } from "bun:test";
import { escalate, resolveEscalationLeg } from "../bin/escalate.ts";

const GATE = "http://127.0.0.1:4101";
const BODY = {
	model: "glm-5.3-flash",
	max_tokens: 16,
	messages: [{ role: "user", content: "Reply OK" }],
};

describe("escalation leg resolution", () => {
	test("scoped gate env enables escalation", () => {
		const leg = resolveEscalationLeg({
			BELT_ESCALATE_URL: GATE,
			BELT_ESCALATE_KEY: "bksk_g",
		});
		expect(leg?.mode).toBe("gate");
		expect(leg?.url).toBe(GATE);
		expect(leg?.key).toBe("bksk_g");
	});
	test("gate env without a scoped key disables escalation", () => {
		expect(resolveEscalationLeg({ BELT_ESCALATE_URL: GATE })).toBeNull();
		expect(
			resolveEscalationLeg({
				BELT_ESCALATE_URL: GATE,
				BELT_ESCALATE_KEY: "litellm-inference-key",
			}),
		).toBeNull();
	});
	test("missing gate URL disables escalation", () => {
		const leg = resolveEscalationLeg({
			BELT_ESCALATE_KEY: "bksk_key_without_url",
		});
		expect(leg).toBeNull();
	});
});

describe("escalate() on the wire", () => {
	test("Buckle 400 carries its echoed call ID and a body-free receipt", async () => {
		let seenCallId = "";
		const receipts: unknown[] = [];
		const result = await escalate(BODY, {
			maxTokens: 16,
			wantFast: true,
			env: { BELT_ESCALATE_URL: GATE, BELT_ESCALATE_KEY: "bksk_test" },
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			requestId: "lane-request-1",
			onAttempt: (receipt) => receipts.push(receipt),
			fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
				seenCallId = new Headers(init?.headers).get("x-litellm-call-id") ?? "";
				return Response.json(
					{ error: { code: "invalid_request", message: "field rejected" } },
					{ status: 400, headers: { "x-litellm-call-id": seenCallId } },
				);
			}) as typeof fetch,
		});
		expect(result.status).toBe(400);
		expect(result.upstreamCallId).toBe(seenCallId);
		expect(receipts[0]).toMatchObject({
			hop: "buckle-gate",
			status: 400,
			failureKind: "http",
			upstreamCallId: seenCallId,
		});
		expect(JSON.stringify(receipts)).not.toContain("field rejected");
	});
	test("carries trace and stable call ID through Buckle", async () => {
		let seen = new Headers();
		const result = await escalate(BODY, {
			maxTokens: 16,
			wantFast: true,
			env: { BELT_ESCALATE_URL: GATE, BELT_ESCALATE_KEY: "bksk_test" },
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			requestId: "belt_1234567890abcdef",
			fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
				seen = new Headers(init?.headers);
				return Response.json(
					{ error: { code: "1302", message: "too many requests" } },
					{
						status: 429,
						headers: {
							"retry-after": "7",
							"x-litellm-call-id": seen.get("x-litellm-call-id") ?? "",
						},
					},
				);
			}) as typeof fetch,
		});
		expect(seen.get("traceparent")?.slice(0, 36)).toBe(
			"00-11111111111111111111111111111111-",
		);
		expect(seen.get("x-litellm-call-id")).toMatch(
			/^belt_11111111111111111111111111111111_[0-9a-f]{16}$/,
		);
		expect(result.upstreamCallId).toBe(seen.get("x-litellm-call-id"));
		expect(result.status).toBe(429);
		expect(result.retryAfterMs).toBe(7000);
	});
	test("gate mode posts to the front with the scoped key on both forms", async () => {
		let seenUrl = "";
		let seenHeaders = new Headers();
		let seenBody: Record<string, unknown> = {};
		const fetcher = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			seenUrl = String(url);
			seenHeaders = new Headers(init?.headers);
			seenBody = JSON.parse(String(init?.body));
			return Response.json({
				content: [{ type: "text", text: "OK" }],
			});
		}) as typeof fetch;
		const r = await escalate(BODY, {
			maxTokens: 16,
			wantFast: true,
			env: { BELT_ESCALATE_URL: GATE, BELT_ESCALATE_KEY: "bksk_wire" },
			fetcher,
		});
		expect(r.text).toBe("OK");
		expect(seenUrl).toBe(`${GATE}/v1/messages`);
		expect(seenHeaders.get("x-api-key")).toBe("bksk_wire");
		expect(seenHeaders.get("authorization")).toBe("Bearer bksk_wire");
		expect(seenBody.model).toBe("glm-5.3-flash");
	});
	test("BELT_ESCALATE_MODEL overrides the Buckle group", async () => {
		let seenUrl = "";
		let _seenBody: Record<string, unknown> = {};
		const fetcher = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			seenUrl = String(url);
			_seenBody = JSON.parse(String(init?.body));
			return Response.json({
				content: [{ type: "text", text: "OK" }],
			});
		}) as typeof fetch;
		const gate = await escalate(BODY, {
			maxTokens: 16,
			wantFast: true,
			env: {
				BELT_ESCALATE_URL: GATE,
				BELT_ESCALATE_KEY: "bksk_test",
				BELT_ESCALATE_MODEL: "glm-5.3",
			},
			fetcher,
		});
		expect(gate.model).toBe("glm-5.3");
		expect(seenUrl).toBe(`${GATE}/v1/messages`);
	});
});
