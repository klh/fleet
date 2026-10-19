import { describe, expect, test } from "bun:test";
import type { BuckleRequestRow } from "../hooks/lib/cache-drill.ts";
import { executionHops } from "../hooks/board/work-execution-trace.ts";

const row = (overrides: Partial<BuckleRequestRow>): BuckleRequestRow => ({
	rid: "r1",
	ts: "2026-10-19T15:00:00.000Z",
	lane: "lane-a",
	actor: "",
	dialect: "anthropic",
	hint: "",
	candidates_seen: 1,
	candidates_top: "",
	target_kind: "cloud",
	target_host: "provider.example",
	target_port: 443,
	target_model: "glm-5.3-flash",
	decision: "allow",
	latency_class: "",
	tier: "",
	allow_cloud: true,
	error_code: null,
	why: "",
	hop: "origin",
	status: 200,
	duration_ms: 310,
	ok: true,
	err: null,
	cache_r: 44,
	cache_c: 12,
	cache_reported: true,
	in_tok: 60,
	out_tok: 25,
	hub: "local",
	...overrides,
});

describe("work execution request hops", () => {
	test("keeps each observed hub hop, drops only duplicate reads, and orders by time", () => {
		const hops = executionHops([
			row({
				rid: "r2",
				ts: "2026-10-19T15:02:00.000Z",
				hub: "nas",
				hop: "peer",
				ok: false,
			}),
			row({ rid: "r1", hub: "local" }),
			row({ rid: "r1", hub: "local" }),
			row({ rid: "r1", hub: "nas", hop: "peer" }),
		]);
		expect(hops).toHaveLength(3);
		expect(hops.map((h) => [h.requestId, h.hub])).toEqual([
			["r1", "local"],
			["r1", "nas"],
			["r2", "nas"],
		]);
		expect(hops[0]).toMatchObject({
			model: "glm-5.3-flash",
			inputTokens: 60,
			outputTokens: 25,
			cacheReadTokens: 44,
			status: "ok",
		});
		expect(hops[2].status).toBe("error");
	});
});
