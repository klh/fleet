// W1294.16: ported 1:1 from router-dead-hub.test.ts to @playwright/test (@api).
import { expect, test } from "@playwright/test";
import type { HopReceipt } from "../../telemetry/src/http-trace.ts";
import { Router } from "../src/router.ts";
import { startMockUpstream } from "./mock.ts";

test.describe({ tag: "@api" }, () => {
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

	test("timed-out row is tried once per tier, not twice before the next tier", async () => {
		const attempted: string[] = [];
		const timeoutMs: number[] = [];
		const slept: number[] = [];
		const router = new Router(
			{
				num_retries: 1,
				allowed_fails: 99,
				request_timeout_s: 120,
				fallbacks: { primary: ["second", "third"] },
			},
			{
				pool: {
					groups: () => ["primary", "second", "third"],
					deployments: (group) => [
						{
							group,
							url: `http://${group}.example.invalid`,
							dialect: "openai",
						},
					],
				},
				sleepMs: async (ms) => {
					slept.push(ms);
				},
				fetchImpl: async (dep, _req, timeout) => {
					attempted.push(dep.group);
					timeoutMs.push(timeout);
					throw new Error("simulated first-byte timeout");
				},
			},
		);
		const result = await router.execute({
			group: "primary",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "primary" },
			key: "",
		});
		expect(result.kind).toBe("exhausted");
		expect(attempted).toEqual(["primary", "second", "third"]);
		expect(timeoutMs).toEqual([120_000, 120_000, 120_000]);
		expect(slept).toEqual([]);
	});

	test("a failed network row still advances to a different same-tier candidate", async () => {
		const attempted: string[] = [];
		const router = new Router(
			{ num_retries: 1, allowed_fails: 99, request_timeout_s: 120 },
			{
				pool: {
					groups: () => ["primary"],
					deployments: () => [
						{
							group: "primary",
							url: "http://first.example.invalid",
							dialect: "openai",
						},
						{
							group: "primary",
							url: "http://second.example.invalid",
							dialect: "openai",
						},
					],
				},
				fetchImpl: async (dep) => {
					attempted.push(dep.url);
					if (dep.url.includes("first")) throw new Error("network timeout");
					return Response.json({ ok: true });
				},
			},
		);
		const result = await router.execute({
			group: "primary",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "primary" },
			key: "",
		});
		expect(result.kind).toBe("upstream");
		expect(attempted).toEqual([
			"http://first.example.invalid",
			"http://second.example.invalid",
		]);
	});
});
