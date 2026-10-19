// test/cache-drill.test.ts — W825: the buckle per-request cache drilldown —
// tolerant wire parse, per-lane aggregates with the warm-cache ratio, the
// miss-reason clusters, filters/sort, and the TTL-cached per-hub fetch cycle
// with honest per-hub degrade (cross-hub-usage test pattern: ?home= module
// isolation + fixture stack/hubs config).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
});

const lib = (): Promise<typeof import("../hooks/lib/cache-drill.ts")> =>
	import(`../hooks/lib/cache-drill.ts?home=${encodeURIComponent(HOME)}`);

type Mod = Awaited<ReturnType<typeof lib>>;
type Row = Mod["BuckleRequestRow"];

const row = (over: Partial<Row>): Row => ({
	rid: "r1",
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
	in_tok: null,
	out_tok: null,
	...over,
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
		expect(parseRequestRow("nope")).toBeNull();
		expect(parseRequestRow({ rid: "", ts: "2026-10-19T09:00:00Z" })).toBeNull();
		expect(parseRequestRow({ rid: "x", ts: "not-a-date" })).toBeNull();
	});
});

describe("laneAggregates", () => {
	test("warm ratio excludes unknown usage; day series + hubs + models", async () => {
		const { laneAggregates } = await lib();
		const lanes = laneAggregates([
			row({ ts: "2026-10-19T10:00:00Z", cache_r: 500 }),
			row({ rid: "r2", ts: "2026-10-19T10:05:00Z", cache_r: 0 }),
			row({ rid: "r3", ts: "2026-10-19T10:06:00Z", cache_r: null }),
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
