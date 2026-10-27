// test/monitor-drill.test.ts — W995: the usage drilldown monitor — dimension
// keys (model/provider/hub/lane), per-group throughput/cache/failure/latency
// aggregates with honest coverage, the hourly uPlot series, and the report
// assembly (probe exclusion, series ceiling, dim fallback). Pure functions —
// fixture rows, no hub fetches.
import { expect, test } from "./pw";
import {
	monitorAggregates,
	monitorKey,
	monitorSeries,
	MONITOR_TOP_N,
	type MonitorDim,
} from "../hooks/lib/fleet-loop/monitor-drill.ts";
import type { BuckleRequestRow } from "../hooks/lib/usage/cache-drill.ts";

const HOUR = 3_600_000;

const row = (over: Partial<BuckleRequestRow>): BuckleRequestRow => ({
	rid: "r1",
	trace_id: null,
	ts: "2026-10-19T10:00:00Z",
	lane: "autow700",
	actor: "key1",
	dialect: "anthropic",
	hint: "",
	candidates_seen: 1,
	candidates_top: "m",
	target_kind: null,
	target_host: null,
	target_port: null,
	target_model: "glm-5.3-flash",
	decision: "route",
	latency_class: "proven",
	tier: "cloud",
	allow_cloud: true,
	error_code: null,
	why: "",
	hop: "origin",
	status: 200,
	duration_ms: 120,
	ok: true,
	err: null,
	cache_r: 4000,
	cache_c: 0,
	cache_reported: true,
	cache_c_reported: null,
	in_tok: null,
	out_tok: null,
	traffic_kind: "inference",
	...over,
});

test.describe("monitorKey", () => {
	test("model falls back to (unrouted); provider rides host:port; hub/lane honest", () => {
		const base = row({});
		expect(monitorKey("model", { ...base, target_model: null })).toBe(
			"(unrouted)",
		);
		expect(
			monitorKey("provider", {
				...base,
				target_host: "api.z.ai",
				target_port: 443,
			}),
		).toBe("api.z.ai:443");
		expect(
			monitorKey("provider", {
				...base,
				target_host: "api.z.ai",
				target_port: null,
			}),
		).toBe("api.z.ai");
		expect(monitorKey("provider", { ...base, target_host: null })).toBe(
			"(unrouted)",
		);
		expect(monitorKey("hub", { ...base, hub: "nas" })).toBe("nas");
		expect(monitorKey("hub", { ...base, hub: undefined })).toBe("(unlisted)");
		expect(monitorKey("lane", { ...base, lane: "" })).toBe("(bare ingress)");
		expect(monitorKey("lane", { ...base, lane: "autow1" })).toBe("autow1");
	});
});

test.describe("monitorAggregates", () => {
	test("groups by dim with throughput, cache, failure, latency + coverage", () => {
		const rows = [
			row({ rid: "a", out_tok: 1000, duration_ms: 100, cache_r: 500 }),
			row({
				rid: "b",
				lane: "autow700",
				ok: false,
				status: 502,
				out_tok: null,
				duration_ms: null,
				cache_r: 0,
			}),
			row({ rid: "c", lane: "autow800", target_model: "haiku", out_tok: 10 }),
		];
		const agg = monitorAggregates(rows, "lane");
		expect(agg.length).toBe(2);
		const w700 = agg.find((r) => r.key === "autow700");
		expect(w700?.requests).toBe(2);
		expect(w700?.out_tok).toBe(1000);
		expect(w700?.tok_reported).toBe(1);
		expect(w700?.failures).toBe(1);
		expect(w700?.failure_observed).toBe(2);
		expect(w700?.known).toBe(2);
		expect(w700?.warm).toBe(1);
		expect(w700?.warm_ratio).toBeCloseTo(0.5);
		expect(w700?.lat_p50_ms).toBe(100);
		expect(w700?.lat_avg_ms).toBe(100);
		// work type: absent from the meter → honest null
		expect(w700?.work).toBeNull();
		// sorted busiest first
		expect(agg[0]?.key).toBe("autow700");
	});

	test("work-type join lands on lane dim only", () => {
		const rows = [row({ lane: "autow700" })];
		const work = { autow700: { orient: 0.5, context: 0.25, spr: 1.5 } };
		const lane = monitorAggregates(rows, "lane", work);
		expect(lane[0]?.work).toEqual({ orient: 0.5, context: 0.25, spr: 1.5 });
		const model = monitorAggregates(rows, "model", work);
		expect(model[0]?.work).toBeNull();
	});

	test("probes excluded from every group", () => {
		const rows = [
			row({ rid: "p", traffic_kind: "readiness", lane: "probe" }),
			row({ rid: "i", lane: "autow700" }),
		];
		const agg = monitorAggregates(rows, "lane");
		expect(agg.length).toBe(1);
		expect(agg[0]?.key).toBe("autow700");
	});

	test("latency percentiles over sorted durations", () => {
		const durs = [10, 20, 30, 40, 100, 200, 300, 400, 500, 600];
		const rows = durs.map((d, i) =>
			row({ rid: `d${String(i)}`, duration_ms: d }),
		);
		const agg = monitorAggregates(rows, "model");
		expect(agg[0]?.lat_known).toBe(10);
		expect(agg[0]?.lat_p50_ms).toBe(100);
		expect(agg[0]?.lat_p95_ms).toBe(600);
		expect(agg[0]?.lat_avg_ms).toBe(220);
	});
});

test.describe("monitorSeries", () => {
	const now = Date.parse("2026-10-19T12:30:00Z");
	test("hourly columnar series for the top groups, zeros filled", () => {
		const days = 1;
		const from = Math.floor((now - days * 86_400_000) / HOUR) * HOUR;
		const inWindow = new Date(from + 2 * HOUR).toISOString();
		const rows = [
			row({
				rid: "x",
				ts: inWindow,
				out_tok: 700,
				duration_ms: 50,
				cache_r: 100,
			}),
			row({
				rid: "y",
				ts: inWindow,
				out_tok: 300,
				duration_ms: 70,
				cache_r: 0,
			}),
			row({ rid: "old", ts: "2026-01-01T00:00:00Z" }),
		];
		const s = monitorSeries(rows, "lane", days, now);
		expect(s).not.toBeNull();
		expect(s?.labels).toEqual(["autow700"]);
		expect(s?.x.length).toBe(25); // 24h window inclusive, hourly
		// column 0 is the x axis; slot 3 holds the in-window bucket
		const slot = 2;
		expect(s?.requests[1]?.[slot]).toBe(2);
		expect(s?.throughput[1]?.[slot]).toBe(1000);
		expect(s?.cache[1]?.[slot]).toBe(1);
		// avg latency (50+70)/2 = 60
		expect(s?.latency[1]?.[slot]).toBe(60);
		expect(s?.failures[1]?.[slot]).toBe(0);
	});

	test("caps at MONITOR_TOP_N groups and returns null with no rows", () => {
		const many = Array.from({ length: MONITOR_TOP_N + 3 }, (_, i) =>
			row({ rid: `m${String(i)}`, lane: `lane${String(i)}` }),
		);
		const s = monitorSeries(many, "lane", 1, now);
		expect(s?.labels.length).toBe(MONITOR_TOP_N);
		expect(monitorSeries([], "model", 1, now)).toBeNull();
	});
});

test.describe("monitorReport", () => {
	test("assembles coverage + dim fallback, no hubs → empty rows", async () => {
		const { monitorReport } = await import(
			`../hooks/lib/fleet-loop/monitor-drill.ts?home=${encodeURIComponent("/nonexistent-home")}`
		);
		const rep = await monitorReport({
			days: 3,
			env: {
				SUSPENDERS_CACHE_LOCAL: "0",
				KLH_STACK: "/nonexistent/stack.yaml",
				SUSPENDERS_HUBS_FILE: "/nonexistent/hubs.json",
			} as Record<string, string>,
			nowMs: Date.parse("2026-10-19T12:00:00Z"),
			endpoints: () => [],
		});
		expect(rep.ok).toBe(true);
		expect(rep.dim).toBe("lane");
		expect(rep.rows).toEqual([]);
		expect(rep.series).toBeNull();
		// label enumeration is env-dependent — every resolved hub must be
		// honestly not-ok with empty rows, never fabricated traffic
		expect(rep.hubs.every((h) => !h.ok)).toBe(true);
		expect(rep.coverage.requests).toBe(0);
	});

	test("unknown dim falls back to lane; work + transcripts ride through", async () => {
		const { monitorReport } = await import(
			`../hooks/lib/fleet-loop/monitor-drill.ts?home=${encodeURIComponent("/nonexistent-home")}`
		);
		const rep = await monitorReport({
			days: 2,
			dim: "bogus" as MonitorDim,
			env: { SUSPENDERS_CACHE_LOCAL: "0" } as Record<string, string>,
			endpoints: () => [],
			nowMs: Date.now(),
			work: { autow700: { orient: 1, context: 0, spr: 0 } },
			transcripts: {
				source: "transcript-v2",
				requests: 5,
				cache_read_tokens: 900,
			},
		});
		expect(rep.dim).toBe("lane");
		expect(rep.transcripts?.source).toBe("transcript-v2");
	});
});
