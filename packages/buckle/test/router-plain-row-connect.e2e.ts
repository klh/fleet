// W2192: ported from W2191's router-plain-row-connect.test.ts to
// @playwright/test (@api) — a dead PLAIN upstream row (no buckle marking,
// the trace 1d57145a shape) is bounded at connect and ejected immediately:
// the fallback serves promptly, the connect receipt records layer/duration/
// retry-after, and the next walk skips the dead row.
import { expect, test } from "@playwright/test";
import type { HopReceipt } from "@klh/telemetry/src/http-trace.ts";
import { Router } from "../src/router.ts";
import { startMockUpstream } from "./mock.ts";

test.describe("@api", () => {
	test("dead plain row: bounded connect ejection, prompt failover, receipt fields", async () => {
		const fallback = await startMockUpstream(() => Response.json({ ok: true }));
		// Bind the dead row to a port the live mock is NOT on — a stopped
		// port-0 Bun.serve port can be re-used by the next port-0 bind, so
		// start the live mock first and spin until the ports differ.
		let deadUrl = "";
		do {
			const dead = Bun.serve({ port: 0, fetch: () => new Response("unused") });
			deadUrl = `http://127.0.0.1:${dead.port}`;
			dead.stop(true);
		} while (deadUrl === fallback.url);
		const receipts: HopReceipt[] = [];
		const router = new Router(
			{
				num_retries: 1,
				allowed_fails: 3,
				cooldown_time: 30,
				request_timeout_s: 120,
				connect_timeout_s: 1,
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
			body: { model: "primary" },
			key: "",
			rid: "w2192-plain-test",
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
			layer: "connect",
			status: null,
		});
		expect(receipts[0]?.retryAfterMs).toBe(30_000);
		const firstLength = receipts.length;
		const second = await router.execute({
			...req,
			rid: "w2192-plain-test-2",
		});
		expect(second.kind).toBe("upstream");
		expect(receipts.slice(firstLength)).toHaveLength(1);
		expect(
			receipts
				.slice(firstLength)
				.every((row) => row.refusal !== "connect_unreachable"),
		).toBe(true);
		fallback.close();
	});
});
