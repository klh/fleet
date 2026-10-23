import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectRoutePerformance,
	currentRoutePerformance,
	routePerformanceFromTallies,
	readRoutePerformanceSnapshot,
	RoutePerformanceRegistry,
	writeRoutePerformanceSnapshot,
	type EndpointMetrics,
} from "../bin/route-performance.ts";

const observedAt = "2026-10-23T06:00:00.000Z";
const observedMs = Date.parse(observedAt);
const temporaryDirs: string[] = [];

const tempDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "route-perf-"));
	temporaryDirs.push(dir);
	return dir;
};

const tally = (overrides: Partial<EndpointMetrics> = {}): EndpointMetrics => ({
	calls: 10,
	errors: 2,
	measured: 8,
	avg_ms: 1200.6,
	last_used: observedAt,
	load_5m: 0,
	...overrides,
});

afterEach(async () => {
	await Promise.all(
		temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("measured route performance", () => {
	test("aggregates tallies into provenance-carrying records", () => {
		const records = routePerformanceFromTallies({
			"macbook:4000:glm-5.3-flash": tally(),
		});
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record?.provider).toBe("macbook");
		expect(record?.modelId).toBe("glm-5.3-flash");
		expect(record?.avgLatencyMs.value).toBe(1201);
		expect(record?.avgLatencyMs.source).toBe("belt:metrics:macbook:4000");
		expect(record?.errorRate.value).toBe(0.2);
		expect(record?.sampleCount.value).toBe(8);
	});

	test("keeps absent or unmeasurable tallies unknown", () => {
		const records = routePerformanceFromTallies({
			"macbook:4000:": tally(),
			"macbook::model": tally(),
			"macbook:4000:broken": tally({ last_used: null }),
			"macbook:4000:stale-format": tally({ last_used: "not-a-date" }),
			"macbook:4000:nosamples": tally({ measured: 0, avg_ms: null }),
		});
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record?.modelId).toBe("nosamples");
		expect(record?.avgLatencyMs.value).toBeNull();
		expect(record?.sampleCount.value).toBeNull();
		expect(record?.errorRate.value).toBe(0.2);
	});

	test("separates routes and merges newer facts per route", () => {
		const registry = new RoutePerformanceRegistry();
		const [a, b] = routePerformanceFromTallies({
			"mac-a:4000:glm-5.3-flash": tally(),
			"mac-b:4001:glm-5.3-flash": tally({ last_used: observedAt }),
		});
		if (!a || !b) throw new Error("fixture invalid");
		registry.upsert(a);
		registry.upsert(b);
		// Same (provider, modelId) pair on a newer endpoint observation wins.
		registry.upsert({
			provider: "mac-a",
			modelId: "glm-5.3-flash",
			avgLatencyMs: {
				value: 900,
				source: "belt:metrics:mac-a:4002",
				observedAt,
			},
			errorRate: { value: 0.5, source: "belt:metrics:mac-a:4002", observedAt },
			sampleCount: { value: 4, source: "belt:metrics:mac-a:4002", observedAt },
		});
		expect(registry.all()).toHaveLength(2);
		const merged = registry.get("mac-a", "glm-5.3-flash", 60_000, observedMs);
		expect(merged?.avgLatencyMs.value).toBe(900);
		expect(merged?.avgLatencyMs.source).toBe("belt:metrics:mac-a:4002");
		expect(
			registry.get("mac-c", "glm-5.3-flash", 60_000, observedMs),
		).toBeNull();
	});

	test("expires stale facts but preserves provenance at read time", () => {
		const record = routePerformanceFromTallies({
			"macbook:4000:glm-5.3-flash": tally(),
		})[0];
		if (!record) throw new Error("fixture invalid");
		const expired = currentRoutePerformance(record, 1000, observedMs + 2000);
		expect(expired.avgLatencyMs.value).toBeNull();
		expect(expired.avgLatencyMs.source).toBe("belt:metrics:macbook:4000");
		expect(expired.avgLatencyMs.observedAt).toBe(observedAt);
		const current = currentRoutePerformance(record, 60_000, observedMs + 1000);
		expect(current.avgLatencyMs.value).toBe(1201);
	});

	test("persists the store atomically with provenance intact", async () => {
		const path = join(await tempDir(), "route-performance.json");
		const registry = new RoutePerformanceRegistry(
			routePerformanceFromTallies({
				"macbook:4000:glm-5.3-flash": tally(),
			}),
		);
		await writeRoutePerformanceSnapshot(path, registry, observedMs);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const loaded = await readRoutePerformanceSnapshot(path);
		expect(loaded.state).toBe("available");
		if (loaded.state !== "available") return;
		expect(loaded.savedAt).toBe(observedAt);
		const roundtrip = loaded.registry.get(
			"macbook",
			"glm-5.3-flash",
			60_000,
			observedMs,
		);
		expect(roundtrip?.avgLatencyMs.value).toBe(1201);
	});

	test("refuses absent and malformed snapshots", async () => {
		const dir = await tempDir();
		const missing = await readRoutePerformanceSnapshot(
			join(dir, "absent.json"),
		);
		expect(missing.state).toBe("missing");
		const path = join(dir, "broken.json");
		await writeFile(path, "not json at all");
		const broken = await readRoutePerformanceSnapshot(path);
		expect(broken.state).toBe("invalid");
		await writeFile(path, JSON.stringify({ version: 2, savedAt: observedAt }));
		const wrongVersion = await readRoutePerformanceSnapshot(path);
		expect(wrongVersion.state).toBe("invalid");
	});

	test("collects from injected tallies into a persisted fresh store", async () => {
		const path = join(await tempDir(), "route-performance.json");
		const feed = await collectRoutePerformance({
			tallies: { "macbook:4000:glm-5.3-flash": tally() },
			path,
			now: observedMs,
		});
		expect(feed.state).toBe("available");
		expect(feed.sources.metrics).toBe("tallied");
		expect(feed.sources.persistence).toBe("saved");
		expect(feed.maxAgeMs).toBe(15 * 60_000);
		expect(feed.records).toHaveLength(1);
		expect(feed.records[0]?.avgLatencyMs.value).toBe(1201);
		const persisted = await readRoutePerformanceSnapshot(path);
		expect(persisted.state).toBe("available");
	});

	test("reports partial when the snapshot path cannot persist", async () => {
		const dir = await tempDir();
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "not a directory");
		const feed = await collectRoutePerformance({
			tallies: {},
			path: join(blocker, "route-performance.json"),
			now: observedMs,
		});
		expect(feed.state).toBe("partial");
		expect(feed.sources.persistence).toBe("unavailable");
	});
});
