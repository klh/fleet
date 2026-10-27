// test/cache-sla.test.ts — W1139.1: rolling per-lane cache hit-share SLA —
// window math, the breaching predicate (sample floor + threshold), sort
// order, badge derivation, status-file round-trip, and the maintenance task
// registry entry (heartbeat-born, W779 pairing).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAINTENANCE_TASKS,
	suspendersRoot,
} from "../hooks/lib/fleet-loop/maintenance.ts";
import {
	cacheSlaBadge,
	cacheSlaStatusPath,
	evaluateCacheSla,
	readCacheSlaStatus,
	rollingHitShares,
} from "../hooks/lib/usage/cache-sla.ts";
import type { CacheRow } from "../hooks/lib/usage/cache-telemetry.ts";

const tmp = mkdtempSync(join(tmpdir(), "cache-sla-"));
process.env.KLH_CACHE_SLA_STATUS = join(tmp, "sla.json");

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
	at: "2026-10-26T12:00:00Z",
	...over,
});

describe("rollingHitShares", () => {
	test("computes per-lane hit share over the window, worst first", () => {
		const now = Date.parse("2026-10-26T12:05:00Z");
		const rows = [
			row("warm", { i: 100, r: 300, c: 0 }), // 0.75
			row("cold", { i: 900, r: 0, c: 0 }), // 0
		];
		const lanes = rollingHitShares(rows, 60 * 60_000, now);
		expect(lanes.map((l) => l.lane)).toEqual(["cold", "warm"]);
		expect(lanes[0]?.hitShare).toBe(0);
		expect(lanes[1]?.hitShare).toBeCloseTo(0.75);
	});

	test("rows older than the window are excluded", () => {
		const now = Date.parse("2026-10-26T12:05:00Z");
		const rows = [
			row("l", { i: 100, r: 0, c: 0 }),
			row(
				"l",
				{ i: 100, r: 900, c: 0 },
				{
					at: "2026-10-26T11:00:00Z", // exactly window-old — excluded
				},
			),
		];
		const lanes = rollingHitShares(rows, 60 * 60_000, now);
		expect(lanes[0]?.inputTok).toBe(100);
	});
});

describe("evaluateCacheSla", () => {
	test("breach = sample floor met AND hit share below threshold", () => {
		const report = evaluateCacheSla(
			[
				row("sub", { i: 900, r: 0, c: 0 }, { requests: 2 }),
				row("breach", { i: 900, r: 0, c: 0 }, { requests: 9 }),
				row("ok", { i: 100, r: 900, c: 0 }, { requests: 9 }),
			],
			{ now: () => Date.parse("2026-10-26T12:05:00Z") },
		);
		expect(report.breaches).toEqual(["breach"]);
	});

	test("empty log → empty report, never a breach", () => {
		const report = evaluateCacheSla([], { now: () => Date.now() });
		expect(report.lanes).toEqual([]);
		expect(report.breaches).toEqual([]);
		expect(cacheSlaBadge(report).level).toBe("nodata");
	});
});

describe("cacheSlaBadge", () => {
	test("ok / breach / nodata vocabulary", () => {
		const fresh = { at: new Date().toISOString() };
		const ok = cacheSlaBadge(
			evaluateCacheSla(
				[row("a", { i: 1, r: 9, c: 0 }, { requests: 9, ...fresh })],
				{ now: () => Date.now() },
			),
		);
		expect(ok.level).toBe("ok");
		const breach = cacheSlaBadge(
			evaluateCacheSla(
				[row("b", { i: 9, r: 0, c: 0 }, { requests: 9, ...fresh })],
				{ now: () => Date.now() },
			),
		);
		expect(breach.level).toBe("breach");
		expect(cacheSlaBadge(null).level).toBe("nodata");
	});
});

describe("readCacheSlaStatus", () => {
	test("round-trips a written report; corrupt/missing → null", () => {
		const path = join(tmp, "status.json");
		const report = evaluateCacheSla(
			[
				row(
					"r",
					{ i: 1, r: 9, c: 0 },
					{
						requests: 9,
						at: new Date().toISOString(),
					},
				),
			],
			{ now: () => Date.now() },
		);
		writeFileSync(path, `${JSON.stringify(report)}\n`);
		const back = readCacheSlaStatus(path);
		expect(back?.breaches).toEqual(report.breaches);
		expect(back?.lanes.length).toBe(1);
		expect(readCacheSlaStatus(join(tmp, "absent.json"))).toBeNull();
		// W1781: "absent.json" is a tmp fixture name, never a repo path —
		// pin the absence so a future restore is a conscious change.
		expect(existsSync("packages/suspenders/test/absent.json")).toBe(false);
		writeFileSync(path, "{nope");
		expect(readCacheSlaStatus(path)).toBeNull();
		expect(existsSync(cacheSlaStatusPath())).toBe(false);
	});
});

describe("test-local status.json fixture (W1780)", () => {
	test("status.json in this suite is a tmpdir fixture, not a repo path", () => {
		// The dangling-path detector flagged packages/suspenders/test/status.json
		// as lost by merge 94b7a050. It never was a repo file: the round-trip
		// test above builds join(tmp, "status.json") inside a mkdtemp dir under
		// the OS tmpdir and writes it itself. Pin both halves of that contract.
		const fixture = join(tmp, "status.json");
		expect(fixture.startsWith(tmpdir())).toBe(true);
		expect(existsSync(join(suspendersRoot(), "test/status.json"))).toBe(
			false,
		);
	});
});

describe("cache-sla maintenance argv (W1782 dangling-path pin)", () => {
	test("the cache-sla.ts literal is a runtime basename, not a repo-relative test path", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "cache-sla");
		const argv0 = task?.argv(suspendersRoot(), "/")[0] ?? "";
		expect(argv0).toContain("cache-sla.ts");
		expect(argv0).toContain("hooks/bin");
		expect(existsSync(join(suspendersRoot(), "test/cache-sla.ts"))).toBe(false);
	});
});

describe("cacheSlaStatusPath (W1779 dangling-path pin)", () => {
	test("the sla.json literal resolves via KLH_CACHE_SLA_STATUS to the tmp fixture — no repo-relative sla.json", () => {
		expect(cacheSlaStatusPath()).toBe(join(tmp, "sla.json"));
		expect(existsSync("packages/suspenders/test/sla.json")).toBe(false);
	});
});

describe("cache-sla maintenance task (W779 pairing)", () => {
	test("registry carries the heartbeat-born cache-sla sweep", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "cache-sla");
		expect(task).toBeDefined();
		expect(task?.everySeconds).toBe(900);
		expect(task?.argv(suspendersRoot(), "/")[0]).toContain("cache-sla.ts");
	});
});
