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
	UNKNOWN_PROVIDER,
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
	measured_last: observedAt,
	measured_first: observedAt,
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
		expect(record?.endpoint).toBe("macbook:4000");
		expect(record?.provider).toBe(UNKNOWN_PROVIDER);
		expect(record?.modelId).toBe("glm-5.3-flash");
		expect(record?.avgLatencyMs.value).toBe(1201);
		expect(record?.avgLatencyMs.source).toBe("belt:metrics:macbook:4000");
		expect(record?.avgLatencyMs.observedAt).toBe(observedAt);
		expect(record?.errorRate.value).toBe(0.2);
		expect(record?.sampleCount.value).toBe(8);
		expect(record?.sampleWindow.value).toEqual({
			first: observedAt,
			last: observedAt,
		});
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
		expect(record?.provider).toBe(UNKNOWN_PROVIDER);
		expect(record?.avgLatencyMs.value).toBeNull();
		expect(record?.sampleCount.value).toBeNull();
		expect(record?.sampleWindow.value).toBeNull();
		expect(record?.errorRate.value).toBe(0.2);
	});

	test("keeps same-host different-port routes as independent records", () => {
		// B1 (W1030.2.1): macbook:4000 (100 ms) and macbook:4100 (900 ms)
		// measured at the same ts stay two records — the old (provider,
		// modelId) key collapsed them into one overwrite-by-order value.
		const registry = new RoutePerformanceRegistry(
			routePerformanceFromTallies({
				"macbook:4000:glm-5.3-flash": tally({ avg_ms: 100.4, measured: 1 }),
				"macbook:4100:glm-5.3-flash": tally({ avg_ms: 900.4, measured: 1 }),
			}),
		);
		expect(registry.all()).toHaveLength(2);
		const fast = registry.get(
			"macbook:4000",
			"glm-5.3-flash",
			60_000,
			observedMs,
		);
		const slow = registry.get(
			"macbook:4100",
			"glm-5.3-flash",
			60_000,
			observedMs,
		);
		expect(fast?.avgLatencyMs.value).toBe(100);
		expect(fast?.provider).toBe(UNKNOWN_PROVIDER);
		expect(slow?.avgLatencyMs.value).toBe(900);
		// order independence: both records keep their own values regardless of
		// Object.entries order — no overwrite, no cross-route aggregation
		expect(registry.all().map((r) => r.avgLatencyMs.value).sort()).toEqual([
			100,
			900,
		]);
	});

	test("merges newer observations per route without touching siblings", () => {
		const registry = new RoutePerformanceRegistry();
		const [a, b] = routePerformanceFromTallies({
			"mac-a:4000:glm-5.3-flash": tally(),
			"mac-b:4001:glm-5.3-flash": tally({ last_used: observedAt }),
		});
		if (!a || !b) throw new Error("fixture invalid");
		registry.upsert(a);
		registry.upsert(b);
		expect(registry.all()).toHaveLength(2);
		const newerAt = "2026-10-23T06:05:00.000Z";
		registry.upsert({
			endpoint: "mac-a:4000",
			provider: UNKNOWN_PROVIDER,
			modelId: "glm-5.3-flash",
			avgLatencyMs: {
				value: 900,
				source: "belt:metrics:mac-a:4000",
				observedAt: newerAt,
			},
			errorRate: {
				value: 0.5,
				source: "belt:metrics:mac-a:4000",
				observedAt: newerAt,
			},
			sampleCount: {
				value: 4,
				source: "belt:metrics:mac-a:4000",
				observedAt: newerAt,
			},
			sampleWindow: {
				value: { first: observedAt, last: newerAt },
				source: "belt:metrics:mac-a:4000",
				observedAt: newerAt,
			},
		});
		expect(registry.all()).toHaveLength(2);
		const newerMs = Date.parse(newerAt);
		const merged = registry.get("mac-a:4000", "glm-5.3-flash", 60_000, newerMs);
		expect(merged?.avgLatencyMs.value).toBe(900);
		expect(merged?.avgLatencyMs.source).toBe("belt:metrics:mac-a:4000");
		const sibling = registry.get(
			"mac-b:4001",
			"glm-5.3-flash",
			60_000,
			observedMs,
		);
		expect(sibling?.avgLatencyMs.value).toBe(1201);
		expect(
			registry.get("mac-c:4000", "glm-5.3-flash", 60_000, observedMs),
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
			"macbook:4000",
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
		expect(feed.records[0]?.endpoint).toBe("macbook:4000");
		expect(feed.records[0]?.provider).toBe(UNKNOWN_PROVIDER);
		expect(feed.records[0]?.avgLatencyMs.value).toBe(1201);
		const persisted = await readRoutePerformanceSnapshot(path);
		expect(persisted.state).toBe("available");
	});

	test("fresh unmeasured failure never rejuvenates stale measured samples", () => {
		// B2 (W1030.2.1): a duration-less failure bumps last_used — real error
		// evidence, so errorRate stays fresh — but the latency fact keeps its
		// own measured-sample timestamp and expires on that, not on activity.
		const staleAt = "2026-10-23T05:00:00.000Z";
		const records = routePerformanceFromTallies({
			"macbook:4000:glm-5.3-flash": tally({
				measured: 1,
				avg_ms: 5000,
				measured_last: staleAt,
				measured_first: staleAt,
				last_used: observedAt,
			}),
		});
		const record = records[0];
		if (!record) throw new Error("fixture invalid");
		expect(record.avgLatencyMs.value).toBe(5000);
		expect(record.avgLatencyMs.observedAt).toBe(staleAt);
		expect(record.errorRate.observedAt).toBe(observedAt);
		const current = currentRoutePerformance(record, 15 * 60_000, observedMs);
		expect(current.avgLatencyMs.value).toBeNull();
		expect(current.avgLatencyMs.source).toBe("belt:metrics:macbook:4000");
		expect(current.errorRate.value).toBe(0.2);
		expect(current.sampleWindow.value).toBeNull();
	});

	test("collects real metrics.db rows through the actual SQLite tallies", async () => {
		// Full-wire regression (W1030.2.1): remotes-routes.log JSONL →
		// metrics.db (bun:sqlite) → metricsSnapshot() tallies → collector →
		// persisted snapshot, in a child process with an isolated HOME so the
		// module-level log/db paths resolve inside the sandbox.
		const home = await tempDir();
		const bin = join(import.meta.dir, "..", "bin");
		const script = join(home, "wire.ts");
		await writeFile(
			script,
			`import { mkdirSync, writeFileSync } from "node:fs/promises";
const llm = process.env.HOME + "/.claude/local-llm";
mkdirSync(llm, { recursive: true });
const ts = new Date(Date.now() - 60_000).toISOString();
const row = (endpoint: string, ms: number): string =>
	JSON.stringify({ ts, machine: "macbook", endpoint, model: "glm-5.3-flash", duration_ms: ms, ok: true });
writeFileSync(llm + "/remotes-routes.log", row("macbook:4000", 100) + "\\n" + row("macbook:4100", 900) + "\\n");
const { metricsSnapshot } = await import(${JSON.stringify(join(bin, "metrics.ts"))});
const { collectRoutePerformance, readRoutePerformanceSnapshot } = await import(${JSON.stringify(join(bin, "route-performance.ts"))});
const snap = metricsSnapshot();
const feed = await collectRoutePerformance({ tallies: snap.endpoints, path: llm + "/route-performance.json", now: Date.now() });
const persisted = await readRoutePerformanceSnapshot(llm + "/route-performance.json");
console.log(JSON.stringify({ keys: Object.keys(snap.endpoints).sort(), feed, persistedState: persisted.state }));
`,
		);
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
