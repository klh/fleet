// test/cache-boundary.test.ts — W458.4: boundary honesty + lane telemetry.
// Covered: boundary identity/equality, hit expectations (model vs boundary
// impossibility), the tenant anti-collapse guard, NDJSON lane telemetry
// roundtrip, per-lane filter + hit-share summary, corrupt-line tolerance,
// attribution surviving a reopened log (failover shape).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundaryKey,
	hitExpectation,
	LaneTelemetryLog,
	mayShareCachePopulation,
	sameBoundary,
	type CacheBoundary,
	type LaneCacheRow,
} from "../src/cache-boundary.ts";

const b = (over: Partial<CacheBoundary> = {}): CacheBoundary => ({
	provider: "anthropic",
	tenant: "ws-1",
	region: "",
	model: "glm-5.3-flash",
	...over,
});

const row = (over: Partial<LaneCacheRow> = {}): LaneCacheRow => ({
	lane: "lane-a",
	task: "W1",
	boundary: b(),
	usage: { in_tok: 1000, out_tok: 200, cache_r: 9000, cache_c: 500 },
	requests: 3,
	wallMs: 4000,
	at: "2026-10-11T00:00:00.000Z",
	...over,
});

describe("cache-boundary: honesty model", () => {
	test("boundary identity is the exact field join", () => {
		expect(boundaryKey(b())).toBe("anthropic|ws-1||glm-5.3-flash");
		expect(sameBoundary(b(), b({ region: "" }))).toBe(true);
		expect(sameBoundary(b(), b({ tenant: "ws-2" }))).toBe(false);
		expect(sameBoundary(b(), b({ model: "other" }))).toBe(false);
	});

	test("hit expectations: possible inside, model mismatch its own case", () => {
		expect(hitExpectation(b(), b())).toBe("possible");
		expect(hitExpectation(b(), b({ model: "other" }))).toBe("impossible-model");
		expect(hitExpectation(b(), b({ tenant: "ws-2" }))).toBe(
			"impossible-boundary",
		);
	});

	test("tenant collapse refused even with an identical prefix key", () => {
		expect(mayShareCachePopulation(b(), b({ tenant: "ws-2" }))).toBe(false);
		expect(mayShareCachePopulation(b(), b())).toBe(true);
	});
});

describe("cache-boundary: per-lane telemetry log", () => {
	const dir = mkdtempSync(join(tmpdir(), "w4584t-"));
	const file = join(dir, "lane-telemetry.jsonl");
	const log = new LaneTelemetryLog(file);
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("append + read + per-lane filter", () => {
		log.append(row());
		log.append(
			row({
				lane: "lane-b",
				usage: { in_tok: 10_000, out_tok: 100, cache_r: 0, cache_c: 10_000 },
			}),
		);
		expect(log.all()).toHaveLength(2);
		expect(log.lane("lane-a")).toHaveLength(1);
	});

	test("hit-share summary keeps writes explicit", () => {
		const s = log.summarize("lane-b");
		expect(s?.requests).toBe(3);
		expect(s?.cacheWrite).toBe(10_000);
		expect(s?.hitShare).toBe(0);
	});

	test("corrupt lines skipped; attribution survives reopening", () => {
		const good = readFileSync(file, "utf8");
		writeFileSync(file, `${good}{damaged\n`);
		const reopened = new LaneTelemetryLog(file);
		expect(reopened.all()).toHaveLength(2);
		const s = reopened.summarize("lane-a");
		expect(s?.hitShare).toBeCloseTo(0.857, 2);
	});

	test("unknown lane summarizes as null", () => {
		expect(log.summarize("nobody")).toBeNull();
	});
});
