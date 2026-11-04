// test/cache-telemetry.test.ts — W825.2: weekly cache-telemetry mining that
// feeds the W822 pulse. Covers row validation, windowing, per-lane warm
// stats, offender/reuse mining, report round-trip, the pulse section, log
// discovery, and the runner CLI face.
import { expect, test } from "./pw";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CacheRow,
	cachePulseSection,
	defaultLaneCacheLog,
	laneWarmStats,
	mineCacheTelemetry,
	readCacheReport,
	readLaneCacheLog,
	rowsInWindow,
} from "../hooks/lib/usage/cache-telemetry.ts";

const tmp = mkdtempSync(join(tmpdir(), "cache-tel-"));
process.env.KLH_CACHE_TELEMETRY = join(tmp, "report.json");

const row = (
	lane: string,
	usage: { i: number; r: number; c: number },
	over: Partial<CacheRow> = {},
): CacheRow => ({
	lane,
	task: "t",
	boundary: { provider: "anthropic", tenant: "acme", region: "", model: "m1" },
	usage: { in_tok: usage.i, out_tok: 10, cache_r: usage.r, cache_c: usage.c },
	requests: 1,
	wallMs: 100,
	at: "2026-10-15T10:00:00Z",
	...over,
});

// lane A: warm (10 reqs, 90% cache reads); lane B: cold (10 reqs, ~9%)
const WARM_ROWS: CacheRow[] = [
	row("warm-lane", { i: 100, r: 900, c: 0 }),
	row("warm-lane", { i: 100, r: 900, c: 0 }),
	row("warm-lane", { i: 100, r: 900, c: 0 }),
	row("warm-lane", { i: 100, r: 900, c: 0 }),
	row("warm-lane", { i: 100, r: 900, c: 0 }),
	row("cold-lane", { i: 900, r: 100, c: 0 }),
	row("cold-lane", { i: 5000, r: 0, c: 0 }),
];

test.describe("rowsInWindow (W825.2)", () => {
	const from = Date.parse("2026-10-13T00:00:00Z");
	test("keeps at/after from, drops older", () => {
		const a = row("l", { i: 1, r: 0, c: 0 }, { at: "2026-10-14T00:00:00Z" });
		const b = row("l", { i: 1, r: 0, c: 0 }, { at: "2026-10-12T00:00:00Z" });
		const kept = rowsInWindow([a, b], from);
		expect(kept.map((r) => r.at)).toEqual(["2026-10-14T00:00:00Z"]);
	});
});

test.describe("readLaneCacheLog (W825.2)", () => {
	test("skips corrupt NDJSON lines, keeps valid rows", () => {
		const p = join(tmp, "mixed.jsonl");
		writeFileSync(
			p,
			[
				JSON.stringify(WARM_ROWS[0]),
				"{broken",
				JSON.stringify(WARM_ROWS[1]),
			].join("\n"),
		);
		expect(readLaneCacheLog(p)).toHaveLength(2);
	});
});

test.describe("laneWarmStats (W825.2)", () => {
	test("groups lanes and computes the warm ratio", () => {
		const stats = laneWarmStats(WARM_ROWS);
		const warm = stats.find((s) => s.lane === "warm-lane");
		const cold = stats.find((s) => s.lane === "cold-lane");
		expect(warm?.warmRatio).toBeCloseTo(0.9, 5);
		expect(cold?.warmRatio).toBeCloseTo(100 / 6000, 5);
		expect(warm?.requests).toBe(5);
		expect(cold?.freshTok).toBe(5900);
	});
});

test.describe("mineCacheTelemetry (W825.2)", () => {
	test("offenders: cold lanes ranked by fresh spend, sample floor", () => {
		const report = mineCacheTelemetry(WARM_ROWS, { minRequests: 2 });
		expect(report.offenders.map((o) => o.lane)).toEqual(["cold-lane"]);
		expect(report.offenders[0]?.freshTok).toBe(5900);
		// warm-lane at 0.9 warm is never an offender at threshold 0.5
		expect(report.offenders.some((o) => o.lane === "warm-lane")).toBe(false);
	});

	test("sample floor: below minRequests no verdicts", () => {
		const report = mineCacheTelemetry(WARM_ROWS, { minRequests: 50 });
		expect(report.offenders).toHaveLength(0);
		expect(report.reuse).toHaveLength(0);
	});
});

test.describe("reuse clustering (W825.2)", () => {
	test("same-boundary spread fires; single-lane groups stay silent", () => {
		const report = mineCacheTelemetry(WARM_ROWS, { minRequests: 2 });
		expect(report.reuse).toHaveLength(1);
		expect(report.reuse[0]?.template).toBe("warm-lane");
		expect(report.reuse[0]?.cold).toEqual(["cold-lane"]);
	});

	test("spread below reuseSpread stays silent", () => {
		const report = mineCacheTelemetry(WARM_ROWS, {
			minRequests: 2,
			reuseSpread: 0.95,
		});
		expect(report.reuse).toHaveLength(0);
	});
});

test.describe("report round-trip (W825.2)", () => {
	test("readCacheReport: missing and corrupt files read as null", () => {
		expect(readCacheReport(join(tmp, "missing.json"))).toBeNull();
		writeFileSync(join(tmp, "bad.json"), "{not json");
		expect(readCacheReport(join(tmp, "bad.json"))).toBeNull();
	});

	test("mined report reads back whole", () => {
		const report = mineCacheTelemetry(WARM_ROWS, { minRequests: 2 });
		const path = join(tmp, "rt.json");
		writeFileSync(path, JSON.stringify(report));
		const back = readCacheReport(path);
		expect(back?.lanes.map((l) => l.lane)).toEqual(
			report.lanes.map((l) => l.lane),
		);
		expect(back?.offenders[0]?.freshTok).toBe(5900);
	});
});

test.describe("cachePulseSection (W825.2)", () => {
	const report = mineCacheTelemetry(WARM_ROWS, { minRequests: 2 });
	test("null on empty report, lines on real data", () => {
		expect(cachePulseSection(null)).toBeNull();
		const empty = mineCacheTelemetry([]);
		expect(cachePulseSection(empty)).toBeNull();
	});

	test("offender and reuse lines render", () => {
		const lines = cachePulseSection(report);
		expect(lines?.[0]).toContain("cache telemetry");
		const joined = (lines ?? []).join("\n");
		expect(joined).toContain("cold-lane cold —");
		expect(joined).toContain("should ride warm-lane's prefix");
	});
});

test.describe("defaultLaneCacheLog (W825.2)", () => {
	test("BUCKLE_LANE_CACHE_LOG pin wins when it exists", () => {
		const fixture = join(tmp, "lane-cache.jsonl");
		writeFileSync(fixture, "");
		const savedLane = process.env.BUCKLE_LANE_CACHE_LOG;
		process.env.BUCKLE_LANE_CACHE_LOG = fixture;
		try {
			expect(defaultLaneCacheLog()).toBe(fixture);
		} finally {
			if (savedLane === undefined) delete process.env.BUCKLE_LANE_CACHE_LOG;
			else process.env.BUCKLE_LANE_CACHE_LOG = savedLane;
		}
	});
});

const runBin = (args: string[]): number => {
	const bin = join(import.meta.dir, "../hooks/bin/cache-telemetry.ts");
	const p = Bun.spawnSync([process.execPath, bin, ...args]);
	return p.exitCode ?? 1;
};

test.describe("runner CLI (W825.2)", () => {
	test.setTimeout(20_000);

	test("mines a fixture log into the report file", () => {
		const logPath = join(tmp, "runner-log.jsonl");
		writeFileSync(logPath, WARM_ROWS.map((r) => JSON.stringify(r)).join("\n"));
		const outPath = join(tmp, "runner-report.json");
		const code = runBin(["--log", logPath, "--out", outPath]);
		expect(code).toBe(0);
		expect(existsSync(outPath)).toBe(true);
		expect(readCacheReport(outPath)?.lanes).toHaveLength(2);
	});

	test("missing log still exits 0 with an empty report", () => {
		const outPath = join(tmp, "runner-empty.json");
		const code = runBin(["--log", join(tmp, "nope.jsonl"), "--out", outPath]);
		expect(code).toBe(0);
		expect(readCacheReport(outPath)?.lanes).toHaveLength(0);
	});
});
