// test/cache-drill.test.ts — W825: the buckle per-request cache drilldown —
// tolerant wire parse, per-lane aggregates with the warm-cache ratio, the
// miss-reason clusters, filters/sort, and the TTL-cached per-hub fetch cycle
// with honest per-hub degrade (cross-hub-usage test pattern: ?home= module
// isolation + fixture stack/hubs config).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-cache-drill-"));
const STACK = join(HOME, "stack.yaml");
const REGISTRY = join(HOME, "hubs.json");
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
	const p = process.env;
	prev.KLH_STACK = p.KLH_STACK;
	prev.SUSPENDERS_HUBS_FILE = p.SUSPENDERS_HUBS_FILE;
	p.KLH_STACK = STACK;
	p.SUSPENDERS_HUBS_FILE = REGISTRY;
	writeFileSync(
		STACK,
		["hubs:", "  hub-a:", "    url: http://127.0.0.1:8501", ""].join("\n"),
	);
	writeFileSync(
		REGISTRY,
		JSON.stringify({
			"hub-c": { candidates: ["http://127.0.0.1:8503"], token: "regtok" },
		}),
	);
});

afterAll(() => {
	const p = process.env;
	if (prev.KLH_STACK === undefined) delete p.KLH_STACK;
	else p.KLH_STACK = prev.KLH_STACK;
	if (prev.SUSPENDERS_HUBS_FILE === undefined) delete p.SUSPENDERS_HUBS_FILE;
	else p.SUSPENDERS_HUBS_FILE = prev.SUSPENDERS_HUBS_FILE;
	rmSync(HOME, { recursive: true, force: true });
});

const env = (): Record<string, string> => ({
	HOME,
	KLH_STACK: STACK,
	SUSPENDERS_HUBS_FILE: REGISTRY,
	SUSPENDERS_CACHE_LOCAL: "0",
});

const lib = (): Promise<typeof import("../hooks/lib/cache-drill.ts")> =>
	import(`../hooks/lib/cache-drill.ts?home=${encodeURIComponent(HOME)}`);

type Mod = Awaited<ReturnType<typeof lib>>;
type Row = Mod["BuckleRequestRow"];

const row = (over: Partial<Row>): Row => ({
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
	...over,
});

const W925_BASE = Date.parse("2026-10-19T12:00:00.000Z");
const w925Iso = (ms: number): string => new Date(ms).toISOString();
const w925Wire = (
	rid: string,
	tsMs: number,
	cacheR = 0,
): Record<string, unknown> => ({
	rid,
	ts: w925Iso(tsMs),
	lane: "lane-a",
	target_model: "glm-5.3-flash",
	cache_r: cacheR,
	cache_reported: 1,
});

describe("parseRequestRow", () => {
	test("keeps usable rows from partial wire entries, drops garbage", async () => {
		const { parseRequestRow } = await lib();
		const ok = parseRequestRow({
			rid: "r9",
			ts: "2026-10-19T09:00:00Z",
			lane: "autow700",
			cache_r: 0,
		});
		expect(ok !== null && ok.rid === "r9" && ok.cache_r === 0).toBe(true);
		expect(ok !== null && ok.target_model === null).toBe(true);
		expect(ok?.cache_c_reported).toBeNull();
		expect(
			parseRequestRow({
				rid: "r10",
				ts: "2026-10-19T09:00:00Z",
				cache_c: 0,
				cache_c_reported: 1,
			})?.cache_c_reported,
		).toBe(true);
		expect(parseRequestRow("nope")).toBeNull();
		expect(parseRequestRow({ rid: "", ts: "2026-10-19T09:00:00Z" })).toBeNull();
		expect(parseRequestRow({ rid: "x", ts: "not-a-date" })).toBeNull();
	});
});

describe("laneAggregates", () => {
	test("cache write totals exclude providers that did not report writes", async () => {
		const { laneAggregates } = await lib();
		const [lane] = laneAggregates([
			row({ rid: "r1", cache_c: 0, cache_c_reported: false }),
			row({ rid: "r2", cache_c: 12, cache_c_reported: true }),
		]);
		expect(lane?.cache_c_known).toBe(1);
		expect(lane?.cache_c_tok).toBe(12);
	});
	test("warm ratio excludes unknown usage; day series + hubs + models", async () => {
		const { laneAggregates } = await lib();
		const lanes = laneAggregates([
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 500 }),
			row({ rid: "r2", ts: "2026-10-19T10:05:00Z", cache_r: 0 }),
			row({
				rid: "r3",
				ts: "2026-10-19T10:06:00Z",
				cache_r: null,
				cache_reported: null,
			}),
			row({
				rid: "r4",
				ts: "2026-10-18T09:00:00Z",
				lane: "",
				cache_r: 0,
				target_model: "q",
				hub: "hub-b",
			}),
		]);
		expect(lanes.length).toBe(2);
		const main = lanes.find((l) => l.lane === "autow700");
		expect(main?.requests).toBe(3);
		expect(main?.known).toBe(2);
		expect(main?.warm).toBe(1);
		expect(main?.warm_ratio).toBe(0.5);
		expect(main?.day_series).toEqual([{ d: "2026-10-19", req: 3, warm: 1 }]);
		const bare = lanes.find((l) => l.lane === "(bare ingress)");
		expect(bare?.hubs).toEqual(["hub-b"]);
	});
});

describe("clusterMissReasons", () => {
	test("interleaved lanes cannot manufacture model drift or repeated cold starts", async () => {
		const { clusterMissReasons } = await lib();
		const clusters = clusterMissReasons([
			row({
				rid: "a1",
				lane: "lane-a",
				ts: "2026-10-19T10:00:00Z",
				cache_r: 0,
				target_model: "model-a",
			}),
			row({
				rid: "b1",
				lane: "lane-b",
				ts: "2026-10-19T10:00:01Z",
				cache_r: 0,
				target_model: "model-b",
			}),
			row({
				rid: "a2",
				lane: "lane-a",
				ts: "2026-10-19T10:00:02Z",
				cache_r: 900,
				target_model: "model-a",
			}),
			row({
				rid: "b2",
				lane: "lane-b",
				ts: "2026-10-19T10:00:03Z",
				cache_r: 900,
				target_model: "model-b",
			}),
		]);
		expect(clusters.map((c) => [c.reason, c.count])).toEqual([
			["cold_start", 2],
		]);
	});

	test("bare ingress cannot be diagnosed as one lane's routing drift", async () => {
		const { clusterMissReasons } = await lib();
		const clusters = clusterMissReasons([
			row({ rid: "bare1", lane: "", cache_r: 0, target_model: "model-a" }),
			row({
				rid: "bare2",
				lane: "",
				ts: "2026-10-19T10:00:01Z",
				cache_r: 0,
				target_model: "model-b",
			}),
		]);
		expect(clusters.map((c) => [c.reason, c.count])).toEqual([
			["unattributed", 2],
		]);
	});
	test("walks the lane in ts order, one rule per miss", async () => {
		const { clusterMissReasons } = await lib();
		const clusters = clusterMissReasons([
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 0 }),
			row({
				rid: "r2",
				ts: "2026-10-19T10:01:00Z",
				cache_r: 0,
				target_model: "other",
			}),
			row({
				rid: "r3",
				ts: "2026-10-19T10:02:00Z",
				cache_r: 0,
				target_model: "other",
				tier: "local",
			}),
		]);
		expect(clusters.map((c) => c.reason)).toEqual([
			"cold_start",
			"target_drift",
			"settings_drift",
		]);
	});

	test("gap past TTL, oversized fresh context, unexplained", async () => {
		const { clusterMissReasons } = await lib();
		const clusters = clusterMissReasons([
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 500 }),
			row({
				rid: "r2",
				ts: "2026-10-19T10:20:00Z",
				cache_r: 0,
			}),
			row({
				rid: "r3",
				ts: "2026-10-19T10:21:00Z",
				cache_r: 0,
				in_tok: 80_000,
			}),
			row({
				rid: "r4",
				ts: "2026-10-19T10:22:00Z",
				cache_r: 0,
				in_tok: 1_000,
			}),
		]);
		expect(clusters.map((c) => c.reason)).toEqual([
			"gap_expiry",
			"cold_full_context",
			"unexplained",
		]);
	});
});

describe("cacheDrillReport", () => {
	test("happy path: two hubs, warm ratios, no lane scope", async () => {
		const m = await lib();
		m.clearCacheDrillTtl();
		const rowsA = [
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 500 }),
			row({ rid: "r2", ts: "2026-10-19T10:01:00Z", cache_r: 0 }),
			row({ rid: "r3", ts: "2026-10-19T10:02:00Z", cache_r: 300 }),
		];
		const rowsB = [row({ rid: "r4", ts: "2026-10-10T10:00:00Z" })];
		const calls: string[] = [];
		const report = await m.cacheDrillReport({
			days: 7,
			env: env(),
			endpoints: (label) => [
				{ url: `http://x/${label}`, via: "test", token: null },
			],
			fetch: async (url) => {
				calls.push(url);
				if (url.endsWith("hub-a")) return { ok: true, rows: rowsA };
				return { ok: true, rows: rowsB };
			},
		});
		expect(report.lanes.map((l) => l.lane)).toEqual(["autow700"]);
		expect(report.overall.warm_ratio).toBe(0.75);
		expect(report.lane_scope).toBeNull();
		expect(calls.length).toBe(2);
	});

	test("filters + lane_scope rows", async () => {
		const m = await lib();
		m.clearCacheDrillTtl();
		const rows = [
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 500 }),
			row({ rid: "r2", ts: "2026-10-19T10:01:00Z", cache_r: 0, hub: "hub-c" }),
			row({
				rid: "r3",
				ts: "2026-10-19T10:02:00Z",
				cache_r: 0,
				in_tok: 90_000,
			}),
		];
		const report = await m.cacheDrillReport({
			days: 7,
			env: env(),
			endpoints: (label) =>
				label === "hub-a"
					? [{ url: "http://x/hub-a", via: "test", token: null }]
					: [],
			filters: { lane: "autow700" },
			fetch: async () => ({ ok: true, rows }),
		});
		expect(report.lane_scope?.lane).toBe("autow700");
		expect(report.lane_scope?.requests.length).toBe(3);
	});

	test("degrade + TTL: seam-missing hub stays honest, rows cached", async () => {
		const m = await lib();
		m.clearCacheDrillTtl();
		let calls = 0;
		const opts = {
			days: 7,
			env: { ...env(), SUSPENDERS_CACHE_DRILL_TTL_MS: "60000" },
			endpoints: (label: string) =>
				label === "hub-a"
					? [{ url: "http://x/hub-a", via: "test", token: null }]
					: [],
			fetch: async () => {
				calls += 1;
				return { ok: false, why: "seam not served (pre-W824 hub)" };
			},
		};
		const r1 = await m.cacheDrillReport(opts);
		expect(r1.hubs[0]?.ok).toBe(false);
		expect(r1.hubs[0]?.reason).toContain("pre-W824");
		expect(r1.overall.requests).toBe(0);
		const r2 = await m.cacheDrillReport(opts);
		expect(calls).toBe(1);
		expect(r2.hubs[0]?.reason).toContain("pre-W824");
	});
});

describe("W925 window walk", () => {
	test("same-ts tie group pages through without loss or repeats", async () => {
		const { fetchHubRequests } = await lib();
		const tie = Array.from({ length: 520 }, (_, i) =>
			w925Wire(`t${String(519 - i).padStart(3, "0")}`, W925_BASE + 1),
		);
		const newer = Array.from({ length: 10 }, (_, i) =>
			w925Wire(`n${9 - i}`, W925_BASE + 600),
		);
		const older = Array.from({ length: 80 }, (_, i) =>
			w925Wire(`o${i}`, W925_BASE - i),
		);
		const page1 = [...newer, ...tie.slice(0, 490)];
		const page2 = [...tie.slice(490), ...older];
		const calls: Array<{ until: string; rid: string }> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const u = new URL(String(input));
			calls.push({
				until: u.searchParams.get("until") ?? "",
				rid: u.searchParams.get("before_rid") ?? "",
			});
			const page = calls.length === 1 ? page1 : page2;
			return new Response(JSON.stringify({ requests: page }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const out = await fetchHubRequests("http://hub", null, 7);
			expect(out.ok).toBe(true);
			if (!out.ok) return;
			expect(out.rows.length).toBe(610);
			expect(new Set(out.rows.map((r) => r.rid)).size).toBe(610);
			expect(out.truncated).toBe(false);
			expect(out.coverageTo).toBe(w925Iso(W925_BASE + 600));
			expect(out.coverageFrom).toBe(w925Iso(W925_BASE - 79));
			expect(calls.length).toBe(2);
			expect(calls[1]).toEqual({
				until: w925Iso(W925_BASE + 1),
				rid: "t030",
			});
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("row cap stops the walk and reports honest coverage", async () => {
		const { fetchHubRequests } = await lib();
		const universe = Array.from({ length: 1000 }, (_, i) =>
			w925Wire(`r${i}`, W925_BASE - i),
		);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const u = new URL(String(input));
			const beforeRid = u.searchParams.get("before_rid");
			const start = beforeRid === null ? 0 : Number(beforeRid.slice(1)) + 1;
			const page = universe.slice(start, start + 500);
			return new Response(JSON.stringify({ requests: page }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const out = await fetchHubRequests("http://hub", null, 7, 4000, 700);
			expect(out.ok).toBe(true);
			if (!out.ok) return;
			expect(out.rows.length).toBe(1000);
			expect(out.truncated).toBe(true);
			expect(out.coverageTo).toBe(w925Iso(W925_BASE));
			expect(out.coverageFrom).toBe(w925Iso(W925_BASE - 999));
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("a hub that ignores the cursor is honestly truncated", async () => {
		const { fetchHubRequests } = await lib();
		const page = Array.from({ length: 500 }, (_, i) =>
			w925Wire(`z${i}`, W925_BASE - i),
		);
		let hits = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			hits += 1;
			return new Response(JSON.stringify({ requests: page }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const out = await fetchHubRequests("http://hub", null, 7);
			expect(out.ok).toBe(true);
			if (!out.ok) return;
			expect(out.rows.length).toBe(500);
			expect(out.truncated).toBe(true);
			expect(hits).toBe(2);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("first-sampled miss on a truncated hub is a window boundary", async () => {
		const { clusterMissReasons } = await lib();
		const miss = row({ rid: "m1", hub: "hub-a", cache_r: 0 });
		const got = clusterMissReasons([miss], {
			truncatedHubs: new Set(["hub-a"]),
		});
		expect(got.map((c) => [c.reason, c.count])).toEqual([
			["window_boundary", 1],
		]);
		expect(clusterMissReasons([miss]).map((c) => c.reason)).toEqual([
			"cold_start",
		]);
	});
	test("truncated hub drives window_boundary into the drill report", async () => {
		const m = await lib();
		m.clearCacheDrillTtl();
		const report = await m.cacheDrillReport({
			days: 7,
			env: env(),
			endpoints: (label) => [
				{ url: `http://x/${label}`, via: "test", token: null },
			],
			fetch: async () => ({
				ok: true,
				rows: [
					row({
						rid: "w1",
						hub: "hub-a",
						lane: "lane-x",
						ts: "2026-10-10T10:00:00Z",
						cache_r: 0,
					}),
				],
				truncated: true,
				coverageFrom: "2026-10-10T10:00:00Z",
				coverageTo: "2026-10-10T10:00:00Z",
			}),
		});
		expect(report.hubs[0]?.truncated).toBe(true);
		const why = report.overall.reasons.map((r) => r.reason);
		expect(why).toContain("window_boundary");
		expect(why).not.toContain("cold_start");
	});
});

describe("cacheDrillParams", () => {
	test("rides the query string", async () => {
		const { cacheDrillParams } = await lib();
		const p = cacheDrillParams(
			new URL(
				"http://b/api/usage/cache-drill?days=14&lane=w700&model=m&day=2026-10-18&miss_only=1&limit=50",
			),
		);
		expect(p.days).toBe(14);
		expect(p.filters).toEqual({
			lane: "w700",
			model: "m",
			day: "2026-10-18",
			missOnly: true,
			sort: "",
			limit: 50,
		});
	});
});
