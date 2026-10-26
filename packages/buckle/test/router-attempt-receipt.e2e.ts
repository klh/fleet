import { expect, test } from "@playwright/test";
import type { HopReceipt } from "../../telemetry/src/http-trace.ts";
import { Router } from "../src/router.ts";

test.describe({ tag: "@unit" }, () => {
	test("Buckle emits one bounded receipt per attempted rung across a fallback", async () => {
		const receipts: HopReceipt[] = [];
		const router = new Router(
			{ num_retries: 0, fallbacks: { primary: ["fallback"] } },
			{
				pool: {
					groups: () => ["primary", "fallback"],
					deployments: (group) => [
						{
							group,
							url: `http://${group}.example.invalid/private`,
							dialect: group === "primary" ? "openai" : "anthropic",
						},
					],
				},
				metrics: {
					fallback: () => {},
					cooldown: () => {},
					refused: () => {},
					attempt: (receipt) => receipts.push(receipt),
				},
				fetchImpl: async (dep) =>
					dep.group === "primary"
						? Response.json(
								{ error: { message: "unsupported" } },
								{
									status: 400,
									headers: {
										"x-request-id": "req_one",
										"x-litellm-call-id": "call_one",
										"retry-after": "2",
									},
								},
							)
						: Response.json(
								{ id: "ok" },
								{
									headers: {
										"x-request-id": "provider_success",
										"x-litellm-call-id": "litellm_success",
									},
								},
							),
			},
		);
		const result = await router.execute({
			group: "primary",
			dialect: "anthropic",
			path: "/v1/messages",
			body: {
				model: "primary",
				messages: [{ role: "user", content: "private prompt" }],
			},
			key: "secret-key",
			rid: "rid-1",
			trace: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				baggage: null,
			},
		});
		expect(result.kind).toBe("upstream");
		expect(receipts).toHaveLength(2);
		expect(
			receipts.map(({ ordinal, status, refusal, hop }) => ({
				ordinal,
				status,
				refusal,
				hop,
			})),
		).toEqual([
			{
				ordinal: 1,
				status: 400,
				refusal: "bad_request",
				hop: "bridged-upstream",
			},
			{ ordinal: 2, status: 200, refusal: null, hop: "upstream" },
		]);
		expect(receipts[0]).toMatchObject({
			rid: "rid-1",
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			upstreamId: "req_one",
			callId: "call_one",
			retryAfterMs: 2000,
		});
		expect(receipts[1]).toMatchObject({
			upstreamId: "provider_success",
			callId: "litellm_success",
		});
		expect(JSON.stringify(receipts)).not.toContain("private prompt");
		expect(JSON.stringify(receipts)).not.toContain("secret-key");
		expect(JSON.stringify(receipts)).not.toContain("example.invalid");
	});
});
