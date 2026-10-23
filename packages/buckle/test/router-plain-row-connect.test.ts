// test/router-plain-row-connect.test.ts — W1096: a dead PLAIN upstream row
// (no buckle marking, the trace 1d57145a shape) is bounded at connect and
// ejected immediately: the fallback serves promptly, the connect receipt
// records layer/duration/retry-after, and the next walk skips the dead row.
import { expect, test } from "bun:test";
import type { HopReceipt } from "../../telemetry/src/http-trace.ts";
import { Router } from "../src/router.ts";
import { startMockUpstream } from "./mock.ts";

test("dead plain row: bounded connect ejection, prompt failover, receipt fields", async () => {
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
		body: { model: "primary", messages: [] },
		key: "",
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
	expect(Number.isFinite(receipts[0]?.durationMs)).toBe(true);
	expect(receipts[1]?.layer).toBe("upstream");
	const afterFirst = receipts.length;
	const second = await router.execute({ ...req, rid: "plain-row-2" });
	expect(second.kind).toBe("upstream");
	// the ejected primary consumed zero attempts in the second walk
	expect(receipts.slice(afterFirst)).toHaveLength(1);
	fallback.close();
});
