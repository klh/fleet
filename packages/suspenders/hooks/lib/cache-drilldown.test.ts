// W826 — cache-drilldown tests: fixture ledger (reduced columns — the lib
// only reads what it selects), report shape, warm-rate math, sort, bust
// heuristics, request page, fail-soft edges.
import { Database } from "bun:sqlite";
import { unlinkSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import {
	bustReasons,
	classify,
	CACHE_TTL_MS,
	costIndex,
	drilldownReport,
	fleetWarm,
	laneRequests,
	type LaneDrill,
	readMiningLines,
} from "./cache-drilldown.ts";
import { mineOffenders } from "../bin/usage-mining.ts";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Fixture ledger with exactly the columns the lib reads. */
function fixture(path: string): string {
	try {
		unlinkSync(path);
	} catch {}
	const db = new Database(path);
	db.run(
		"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT DEFAULT '', dialect TEXT DEFAULT '', target_model TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT, cache_r INTEGER, cache_c INTEGER, decision TEXT DEFAULT '', hop TEXT)",
	);
	db.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	db.run(
		"CREATE TABLE router_usage (hour_bucket TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', model_group TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY (hour_bucket, key, model_group, model))",
	);
	db.run("INSERT INTO api_keys VALUES ('k1', 'laneA')");
	db.run(
		"INSERT INTO router_usage VALUES ('2026-10-18T12:00', 'k1', 'flash', 'glm-5.3-flash', 1000, 500, 300, 700, 3)",
	);
	db.close();
	return path;
}

const LEDGER = fixture(`${import.meta.dir}/w826-ledger-probe.db`);

function ins(
	rid: string,
	tsMs: number,
	lane: string,
	model: string,
	cr: number,
	cc = 0,
	dialect = "anthropic",
): void {
	const db = new Database(LEDGER);
	db.run(
		"INSERT INTO route_audit (rid, ts, lane, dialect, target_model, status, duration_ms, ok, cache_r, cache_c, decision) VALUES (?, ?, ?, ?, ?, 200, 500, 1, ?, ?, 'complexity-v3')",
		[rid, iso(tsMs), lane, dialect, model, cr, cc],
	);
	db.close();
}

function seed(): void {
	// laneA: 3 req, 1 warm (prefix-drift story); laneB: 2 req, 0 warm
	ins("a1", T0, "laneA", "glm-5.3-flash", 0, 60_000); // cold-start + oversized-write
	ins("a2", T0 + 60_000, "laneA", "glm-5.3-flash", 500); // warm
	ins("a3", T0 + 120_000, "laneA", "glm-3.1", 0); // model-hop
	ins("b1", T0, "laneB", "glm-5.3-flash", 0, 60_000); // cold-start
	ins("b2", T0 + 600_000, "laneB", "glm-5.3-flash", 0); // ttl-expiry (10min gap)
}
seed();

describe("classify", () => {
	const warm = (
		tsMs: number,
	): { model: string; cacheR: number; tsMs: number } => ({
		model: "m",
		cacheR: 5,
		tsMs,
	});
	const cold = (
		tsMs: number,
		model = "m",
	): { model: string; cacheR: number; tsMs: number } => ({
		model,
		cacheR: 0,
		tsMs,
	});

	test("warm rows never bust; first row is cold-start", () => {
		expect(classify(null, warm(0))).toBeNull();
		expect(classify(null, cold(0))).toBe("cold-start");
	});

	test("warm→cold inside TTL = prefix-drift; >TTL = ttl-expiry; model swap = model-hop", () => {
		expect(classify(warm(0), cold(CACHE_TTL_MS - 1))).toBe("prefix-drift");
		expect(classify(warm(0), cold(CACHE_TTL_MS + 1))).toBe("ttl-expiry");
		expect(classify(warm(0), cold(1, "other"))).toBe("model-hop");
	});
});

describe("bustReasons", () => {
	test("cold-run streak counting: N cold ≤TTL-spaced rows yield N-1 streaks", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({
			tsMs: i * 60_000,
			model: "m",
			cacheR: 0,
			cacheC: 0,
			dialect: "anthropic",
		}));
		const s = bustReasons(rows);
		expect(s.find((r) => r.reason === "streak")?.count).toBe(29);
		expect(s.find((r) => r.reason === "ttl-expiry")).toBeUndefined();
	});

	test("classifies each cold row once; warm row resets the chain", () => {
		const rs = bustReasons([
			{ tsMs: 0, model: "m", cacheR: 0, cacheC: 0, dialect: "anthropic" },
			{ tsMs: 1_000, model: "m", cacheR: 4, cacheC: 0, dialect: "anthropic" },
			{ tsMs: 2_000, model: "m", cacheR: 0, cacheC: 0, dialect: "anthropic" },
		]);
		const get = (n: string): number =>
			rs.find((r) => r.reason === n)?.count ?? 0;
		expect(get("prefix-drift")).toBe(1);
		expect(get("oversized-write")).toBe(0);
	});
});

describe("drilldownReport", () => {
	const NOW = T0 + 3_600_000;
	const lane = (name: string): LaneDrill | undefined =>
		drilldownReport(LEDGER, { days: 7 }, NOW).lanes.find(
			(l) => l.lane === name,
		);

	test("per-lane aggregates, warm-rate math, fleet rollup", () => {
		const r = drilldownReport(LEDGER, { days: 7 }, NOW);
		expect(r.available).toBe(true);
		expect(r.fleet.requests).toBe(5);
		expect(r.fleet.warm).toBe(1);
		const a = lane("laneA");
		expect(a?.requests).toBe(3);
		expect(a?.warm).toBe(1);
		expect(a?.warmRate).toBeCloseTo(1 / 3);
		expect(a?.cacheC).toBe(60_000);
		const why = a?.reasons.map((x) => x.reason) ?? [];
		expect(why).toContain("oversized-write");
		expect(why).toContain("model-hop");
	});

	test("sort=cache-miss puts the all-cold lane first; models facet lists both", () => {
		const r = drilldownReport(LEDGER, { sort: "cache-miss" }, NOW);
		expect(r.lanes[0].lane).toBe("laneB");
		expect(r.models.sort()).toEqual(["glm-3.1", "glm-5.3-flash"].sort());
	});

	test("model filter cuts lanes to that model's rows", () => {
		const r = drilldownReport(LEDGER, { model: "glm-3.1" }, NOW);
		expect(r.lanes.find((l) => l.lane === "laneA")?.requests).toBe(1);
	});

	test("tokens ride router_usage ⋈ api_keys (laneA named)", () => {
		const a = lane("laneA");
		expect(a?.tokens).toBe(2500);
	});
});

describe("laneRequests", () => {
	const NOW = T0 + 3_600_000;

	test("newest-first rows, missOnly cut, truncation flag", () => {
		const p = laneRequests(LEDGER, { lane: "laneA", missOnly: true }, NOW);
		expect(p.available).toBe(true);
		expect(p.total).toBe(2); // a1 + a3, misses only
		expect(p.rows.map((r) => r.rid)).toEqual(["a3", "a1"]);
		expect(p.truncated).toBe(false);
		const p2 = laneRequests(LEDGER, { lane: "laneA", limit: 2 }, NOW);
		expect(p2.total).toBe(3);
		expect(p2.rows.length).toBe(2);
		expect(p2.truncated).toBe(true);
	});

	test("fail-soft: unknown lane and missing ledger degrade honestly", () => {
		const p = laneRequests(LEDGER, { lane: "nope" }, NOW);
		expect(p.available).toBe(true);
		expect(p.total).toBe(0);
		expect(laneRequests(null, { lane: "laneA" }).available).toBe(false);
	});
});

describe("costIndex + fleetWarm", () => {
	test("cost index weights cached input cheap, output expensive", () => {
		expect(costIndex({ in: 100, out: 10, cacheR: 1000, cacheC: 0 })).toBe(
			100 * 1 + 10 * 5 + 1000 * 0.1 + 0,
		);
	});

	test("fleetWarm: live share + worst lane; null when ledger absent/empty", () => {
		const w = fleetWarm(LEDGER, { nowMs: T0 + 3_600_000 });
		expect(w?.rate).toBeCloseTo(0.2);
		expect(w?.worst?.lane).toBe("laneB");
		expect(fleetWarm("/nonexistent.db")).toBeNull();
		expect(fleetWarm(LEDGER, { nowMs: T0 - 86_400_000 * 99 })).toBeNull();
	});
});

// W826 stage 3: the mining runner's ranking + the pulse's artifact read
describe("mineOffenders + readMiningLines", () => {
	test("ranks ≥20-req lanes worst-warm-first; artifact round-trips as pulse lines", () => {
		const path = `${import.meta.dir}/w826-mining-probe.db`;
		try {
			unlinkSync(path);
		} catch {}
		const db = new Database(path);
		db.run(
			"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT DEFAULT '', dialect TEXT DEFAULT '', target_model TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT, cache_r INTEGER, cache_c INTEGER, decision TEXT DEFAULT '', hop TEXT)",
		);
		db.run(
			"CREATE TABLE router_usage (hour_bucket TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', model_group TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY (hour_bucket, key, model_group, model))",
		);
		for (let i = 0; i < 25; i++)
			db.run(
				"INSERT INTO route_audit VALUES (?, ?, 'laneX', 'anthropic', 'm1', 200, 5, 1, NULL, 0, 0, 'x', '')",
				[`x${i}`, iso(T0 + i * 1000)],
			);
		for (let i = 0; i < 20; i++)
			db.run(
				"INSERT INTO route_audit VALUES (?, ?, 'laneY', 'anthropic', 'm1', 200, 5, 1, NULL, 500, 0, 'x', '')",
				[`y${i}`, iso(T0 + i * 1000)],
			);
		db.close();
		const prev = process.env.SUSPENDERS_BUCKLE_DB;
		process.env.SUSPENDERS_BUCKLE_DB = path;
		try {
			const a = mineOffenders(T0 + 3_600_000);
			expect(a.offenders.map((o) => o.lane)).toEqual(["laneX", "laneY"]);
			expect(a.offenders[0]?.topReason).toBe("streak");
			const art = { at: Date.now(), days: 7, offenders: a.offenders };
			const tmp = `${import.meta.dir}/w826-mining-artifact.json`;
			writeFileSync(tmp, JSON.stringify(art));
			expect(readMiningLines(Date.now(), 8 * 86_400_000, tmp)[0]).toContain(
				"laneX",
			);
			expect(readMiningLines(T0 + 9 * 86_400_000, 8 * 86_400_000, tmp)).toEqual(
				[],
			);
			unlinkSync(tmp);
		} finally {
			if (prev === undefined) delete process.env.SUSPENDERS_BUCKLE_DB;
			else process.env.SUSPENDERS_BUCKLE_DB = prev;
		}
		unlinkSync(path);
	});
});

afterAll(() => {
	try {
		unlinkSync(LEDGER);
	} catch {}
});
