// test/cache-sla.test.ts — W1139.1: rolling per-lane cache hit-share SLA —
// window math, the breaching predicate (sample floor + threshold), sort
// order, badge derivation, status-file round-trip, and the maintenance task
// registry entry (heartbeat-born, W779 pairing).
import { expect, test } from "@playwright/test";
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

test.describe("rollingHitShares", () => {
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

test.describe("evaluateCacheSla", () => {
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

test.describe("cacheSlaBadge", () => {
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

test.describe("readCacheSlaStatus", () => {
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
		writeFileSync(path, "{nope");
		expect(readCacheSlaStatus(path)).toBeNull();
		expect(existsSync(cacheSlaStatusPath())).toBe(false);
	});
});

test.describe("cache-sla maintenance task (W779 pairing)", () => {
	test("registry carries the heartbeat-born cache-sla sweep", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "cache-sla");
		expect(task).toBeDefined();
		expect(task?.everySeconds).toBe(900);
		expect(task?.argv(suspendersRoot(), "/")[0]).toContain("cache-sla.ts");
	});
});
