import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThroughputStore } from "../src/throughput-store.ts";
import { rollupThroughput } from "../src/throughput-rollup.ts";
import {
	addThroughputSample,
	evaluateThroughput,
	DEFAULT_THROUGHPUT_POLICY,
	assertThroughputPolicy,
	type ThroughputSample,
	type ThroughputBaseline,
} from "../src/throughput.ts";

const p = {
	...DEFAULT_THROUGHPUT_POLICY,
	bucketMs: 1000,
	minSamples: 2,
	baselineBuckets: 3,
	sustainBuckets: 2,
	recoveryBuckets: 2,
};
const sample = (id: string, at: number, serviceMs = 10): ThroughputSample => ({
	id,
	at,
	node: "fixture-node",
	traceId: "a".repeat(32),
	callId: null,
	requestedGroup: "task",
	model: "actual-model",
	provider: "fixture-provider",
	providerProfile: "fixture-account",
	effort: "high",
	context: "1024",
	ok: true,
	attempts: 2,
	queueMs: 5,
	serviceMs,
	totalMs: serviceMs + 5,
	outTokens: 100,
	demand: true,
	paused: false,
});

function bucket(at: number, serviceMs = 10) {
	return addThroughputSample(
		addThroughputSample(null, sample(`${at}-a`, at, serviceMs), p),
		sample(`${at}-b`, at + 1, serviceMs),
		p,
	);
}

test("known usage and attempts never fabricate tokens or client request counts", () => {
	const b = addThroughputSample(
		null,
		{ ...sample("unknown", 1), outTokens: null },
		p,
	);
	expect(b).toMatchObject({
		requests: 1,
		attempts: 2,
		retries: 1,
		unknownUsage: 1,
		knownUsage: 0,
		serviceSamples: 0,
		serviceTokens: 0,
	});
	expect(evaluateThroughput(b, null, p, 1001).rate).toBeNull();
});

test("policy rejects incomplete and unbounded telemetry while allowing a larger bounded catalogue", () => {
	expect(() => assertThroughputPolicy({ bucketMs: 1 })).toThrow();
	expect(() => assertThroughputPolicy({ ...p, alpha: 0 })).toThrow();
	expect(() =>
		assertThroughputPolicy({ ...p, maxDimensions: 20_001 }),
	).toThrow();
	expect(() =>
		assertThroughputPolicy({ ...p, retentionBuckets: 20, maxDimensions: 600 }),
	).not.toThrow();
});

test("disk reopen retains trained references and exact request deduplication", () => {
	const dir = mkdtempSync(join(tmpdir(), "throughput-durable-"));
	let db: Database | null = null;
	try {
		const path = join(dir, "metrics.sqlite");
		db = new Database(path);
		let store = new ThroughputStore(db, p);
		for (let window = 0; window < 3; window++) {
			for (let n = 0; n < 2; n++)
				store.observe(sample(`${window}-${n}`, window * 1000 + n));
			store.snapshot((window + 1) * 1000 + 1);
		}
		db.close();
		db = new Database(path);
		store = new ThroughputStore(db, p);
		expect(store.observe(sample("2-1", 2001))).toBe("duplicate");
		const restored = store.snapshot(3001).at(-1);
		expect(restored?.baseline?.rate).toBe(10_000);
		expect(restored?.baseline?.buckets).toBe(3);
		expect(restored?.bucket.requests).toBe(2);
	} finally {
		db?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sustained slow known cohort warns once, freezes reference, recovers with hysteresis", () => {
	let state: ThroughputBaseline | null = null;
	for (let i = 0; i < 3; i++)
		state = evaluateThroughput(
			bucket(i * 1000),
			state,
			p,
			(i + 1) * 1000 + 1,
		).baseline;
	expect(state?.rate).toBe(10_000);
	let slow = evaluateThroughput(bucket(3000, 30), state, p, 4001);
	expect(slow.transition).toBeNull();
	slow = evaluateThroughput(bucket(4000, 30), slow.baseline, p, 5001);
	expect(slow.transition).toBe("warning");
	expect(slow.baseline?.rate).toBe(10_000);
	const repeated = evaluateThroughput(bucket(4000, 30), slow.baseline, p, 5001);
	expect(repeated.transition).toBeNull();
	let recovered = evaluateThroughput(bucket(5000), slow.baseline, p, 6001);
	expect(recovered.state).toBe("degraded");
	recovered = evaluateThroughput(bucket(6000), recovered.baseline, p, 7001);
	expect(recovered.transition).toBe("recovery");
});

test("healthy idle missing-route missing-usage stale and paused evidence never warn", () => {
	for (const transform of [
		(b: ReturnType<typeof bucket>) => ({ ...b, demandSamples: 0 }),
		(b: ReturnType<typeof bucket>) => ({ ...b, provider: null }),
		(b: ReturnType<typeof bucket>) => ({
			...b,
			knownUsage: 0,
			unknownUsage: 2,
		}),
		(b: ReturnType<typeof bucket>) => ({ ...b, paused: true }),
	]) {
		const r = evaluateThroughput(
			transform(bucket(4000, 30)),
			{
				rate: 10_000,
				endToEndRate: 100_000 / 15,
				buckets: 5,
				samples: 10,
				lastBucket: 3000,
				low: 1,
				healthy: 0,
				incident: false,
			},
			p,
			5001,
		);
		expect(r.state).toBe("unknown");
		expect(r.transition).toBeNull();
		expect(r.baseline?.low).toBe(0);
		const repeated = evaluateThroughput(
			transform(bucket(4000, 30)),
			r.baseline,
			p,
			5001,
		);
		expect(repeated.state).toBe("unknown");
		expect(repeated.reason).toBe(r.reason);
		expect(repeated.baseline).toEqual(r.baseline);
	}
	expect(evaluateThroughput(bucket(0), null, p, 9000).reason).toBe("stale");
});

test("same shared SQLite store persists buckets, deduplicates requests and bounds cardinality", () => {
	const db = new Database(":memory:");
	const limits = {
		...p,
		maxDimensions: 1,
		maxSamplesPerBucket: 2,
		retentionBuckets: 2,
	};
	let store = new ThroughputStore(db, limits);
	expect(store.observe(sample("one", 1))).toBe("recorded");
	expect(store.observe(sample("one", 1))).toBe("duplicate");
	expect(store.observe({ ...sample("other", 2), provider: "another" })).toBe(
		"capacity",
	);
	expect(store.observe(sample("two", 2))).toBe("recorded");
	expect(store.observe(sample("three", 3))).toBe("capacity");
	store = new ThroughputStore(db, limits);
	expect(store.snapshot(1001)[0]?.bucket.requests).toBe(2);
	store.observe(sample("later", 5001));
	expect(store.snapshot(6001)).toHaveLength(1);
	db.close();
});

test("admission backlog is distinct from healthy upstream service and incidents survive rereads", () => {
	const db = new Database(":memory:");
	let store = new ThroughputStore(db, p);
	const writeWindow = (at: number, queued: boolean) => {
		for (let n = 0; n < 2; n++)
			store.observe({
				...sample(`${at}-${n}`, at + n),
				queueMs: queued ? 197_000 : 5,
				totalMs: queued ? 197_010 : 15,
			});
		return store.snapshot(at + 1001);
	};
	for (let i = 0; i < 3; i++) writeWindow(i * 1000, false);
	writeWindow(3000, true);
	const rows = writeWindow(4000, true);
	expect(rows.at(-1)?.reason).toBe("queue_or_admission_slow");
	expect(rows.at(-1)?.rate).toBe(10_000);
	expect(rows.at(-1)?.transition).toBe("warning");
	const incident = store.incidents()[0];
	expect(incident?.ended).toBeNull();
	store = new ThroughputStore(db, p); // same durable state after component restart
	store.snapshot(5001);
	store.snapshot(5001);
	expect(store.incidents()).toHaveLength(1);
	writeWindow(5000, false);
	writeWindow(6000, false);
	expect(store.incidents()[0]?.id).toBe(incident?.id);
	expect(store.incidents()[0]?.ended).toBe(6000);
	db.close();
});

test("total model and provider rollups compare the current cohort mix without summing rates", () => {
	const a = bucket(1000),
		b = addThroughputSample(
			null,
			{ ...sample("b", 1000, 100), model: "other-model" },
			p,
		);
	const rows = [a, b].map((bucket) => ({
		bucket,
		rate: (bucket.serviceTokens * 1000) / bucket.knownServiceMs,
		endToEndRate: (bucket.serviceTokens * 1000) / bucket.matchedTotalMs,
		ratio: 1,
		reason: null,
		transition: null,
		state: "healthy" as const,
		baseline: {
			rate: (bucket.serviceTokens * 1000) / bucket.knownServiceMs,
			endToEndRate: (bucket.serviceTokens * 1000) / bucket.matchedTotalMs,
			buckets: 4,
			samples: 8,
			lastBucket: 1000,
			low: 0,
			healthy: 0,
			incident: false,
		},
	}));
	const total = rollupThroughput(rows).find((row) => row.dimension === "total");
	expect(total?.bucket.requests).toBe(3);
	expect(total?.bucket.attempts).toBe(6);
	expect(total?.baselineRate).toBeCloseTo((300 * 1000) / 120, 6);
	expect(total?.baselineRate).not.toBe(11_000);
	expect(
		rollupThroughput(rows).filter((row) => row.dimension === "model"),
	).toHaveLength(2);
	expect(
		rollupThroughput(rows).filter((row) => row.dimension === "provider"),
	).toHaveLength(1);
});
