// w422-17-3-escalate.test.ts — W422.17.3: the :4000 router's cloud-escalation
// leg rides the buckle gate when the operator sets BELT_ESCALATE_URL/KEY
// (scoped buckle:proxy:WRITE_ key), keeps the legacy settings.json leg when
// not enrolled, and disables honestly when neither exists. Stub fetchers
// only — never the live :890x fleet, never real creds.
import { describe, expect, test } from "bun:test";
import {
	escalate,
	resolveEscalationLeg,
} from "../bin/escalate.ts";

const GATE = "http://127.0.0.1:4101";
const BODY = {
	model: "glm-5.3-flash",
	max_tokens: 16,
	messages: [{ role: "user", content: "Reply OK" }],
};

describe("escalation leg resolution", () => {
	test("gate env beats legacy creds", async () => {
		const leg = await resolveEscalationLeg(
			{ BELT_ESCALATE_URL: GATE, BELT_ESCALATE_KEY: "bksk_g" },
			async () => ({ tok: "legacy", base: "http://127.0.0.1:4100" }),
		);
		expect(leg?.mode).toBe("gate");
		expect(leg?.url).toBe(GATE);
		expect(leg?.key).toBe("bksk_g");
	});
	test("gate env without a key falls back to legacy", async () => {
		const leg = await resolveEscalationLeg(
			{ BELT_ESCALATE_URL: GATE },
			async () => ({ tok: "legacy", base: "http://127.0.0.1:4100" }),
		);
		expect(leg?.mode).toBe("legacy");
		expect(leg?.key).toBe("legacy");
	});
	test("neither gate env nor legacy creds → escalation disabled", async () => {
		const leg = await resolveEscalationLeg(
			{ BELT_ESCALATE_KEY: "bksk_key_without_url" },
			async () => ({}),
		);
		expect(leg).toBeNull();
	});
});

describe("escalate() on the wire", () => {
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
	test("BELT_ESCALATE_MODEL overrides the wire model; legacy leg keeps pins", async () => {
		let seenUrl = "";
		let seenBody: Record<string, unknown> = {};
		const fetcher = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			seenUrl = String(url);
			seenBody = JSON.parse(String(init?.body));
			return Response.json({
				content: [{ type: "text", text: "OK" }],
			});
		}) as typeof fetch;
		const gate = await escalate(BODY, {
			maxTokens: 16,
			wantFast: true,
			env: {
				BELT_ESCALATE_URL: GATE,
				BELT_ESCALATE_KEY: "k",
				BELT_ESCALATE_MODEL: "glm-5.3",
			},
			fetcher,
		});
		expect(gate.model).toBe("glm-5.3");
		const legacy = await escalate(BODY, {
			maxTokens: 16,
			wantFast: false,
			env: {},
			settings: async () => ({ tok: "t", base: "http://127.0.0.1:4100" }),
			fetcher,
		});
		expect(legacy.model).toBe("glm-5.3");
		expect(seenUrl).toBe("http://127.0.0.1:4100/v1/messages");
	});
});
