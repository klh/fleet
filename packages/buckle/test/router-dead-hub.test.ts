import { expect, test } from "bun:test";
import type { HopReceipt } from "../../telemetry/src/http-trace.ts";
import { Router } from "../src/router.ts";
import { startMockUpstream } from "./mock.ts";

test("dead Buckle peer ejects on connect and the fallback serves promptly", async () => {
	const dead = Bun.serve({ port: 0, fetch: () => new Response("unused") });
	const deadUrl = `http://127.0.0.1:${dead.port}`;
	dead.stop(true);
	const fallback = await startMockUpstream(() => Response.json({ ok: true }));
	const receipts: HopReceipt[] = [];
	const router = new Router(
		{
			num_retries: 1,
			allowed_fails: 3,
			cooldown_time: 30,
			request_timeout_s: 120,
			fallbacks: { primary: ["fallback"] },
		},
		{
			pool: {
				groups: () => ["primary", "fallback"],
				deployments: (group) => [
					{
						group,
						url: group === "primary" ? deadUrl : fallback.url,
						dialect: "openai",
						buckle: group === "primary",
					},
				],
			},
			metrics: {
				fallback: () => {},
				cooldown: () => {},
				refused: () => {},
				attempt: (row) => receipts.push(row),
			},
		},
	);
	const req = {
		group: "primary",
		dialect: "openai" as const,
		path: "/v1/chat/completions",
		body: { model: "primary", messages: [] },
		key: "",
		rid: "dead-hub-test",
		trace: {
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			baggage: null,
		},
	};
	const started = Date.now();
	const first = await router.execute(req);
	expect(first.kind).toBe("upstream");
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(receipts).toHaveLength(2);
	expect(receipts[0]).toMatchObject({
		refusal: "connect_unreachable",
		hop: "upstream",
		status: null,
	});
	expect(receipts[0]?.retryAfterMs).toBe(30_000);
	const firstLength = receipts.length;
	const second = await router.execute({ ...req, rid: "dead-hub-test-2" });
	expect(second.kind).toBe("upstream");
	expect(receipts.slice(firstLength)).toHaveLength(1);
	expect(
		receipts
			.slice(firstLength)
			.every((row) => row.refusal !== "connect_unreachable"),
	).toBe(true);
	fallback.close();
});
