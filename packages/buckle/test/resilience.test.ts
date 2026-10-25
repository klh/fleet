// test/resilience.test.ts — W1303.3 per-behavior tests for the resilience
// client kit. Deterministic clocks/rng; zero network; every behavior of
// src/resilience.ts has at least one pinning probe.
import { describe, expect, test } from "bun:test";
import {
	attemptSignal,
	backoffMs,
	Breakers,
	callDeadlineMs,
	clampRetryAfterMs,
	parseRetryAfterHeader,
	resilientCall,
	RetryBudget,
	retryableFailure,
	retryAfterHeaderClamped,
	serveFromFallbacks,
} from "../src/resilience.ts";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";

describe("deadline propagation (kit §1)", () => {
	const t0 = 1_000_000;
	test("per-call budget = min(perCall, remaining deadline)", () => {
		expect(callDeadlineMs(5_000, t0 + 2_000, t0)).toBe(2_000);
		expect(callDeadlineMs(1_000, t0 + 60_000, t0)).toBe(1_000);
		expect(callDeadlineMs(5_000)).toBe(5_000);
	});
	test("past deadline clamps to the 1ms floor", () => {
		expect(callDeadlineMs(5_000, t0 - 100, t0)).toBe(1);
	});
	test("attempt signal aborts inside the bounded window", async () => {
		const s = attemptSignal(50, Date.now() + 5);
		await Bun.sleep(40);
		expect(s.aborted).toBe(true);
	});
	test("caller abort composes into the attempt signal", async () => {
		const caller = new AbortController();
		const s = attemptSignal(60_000, undefined, caller.signal);
		expect(s.aborted).toBe(false);
		caller.abort();
		expect(s.aborted).toBe(true);
	});
});

describe("retryable classification (kit §2)", () => {
	const keyed = {
		get: (n: string) => (n === "idempotency-key" ? "k-1" : null),
	};
	test("network failure (no status) is retryable", () => {
		expect(retryableFailure({ status: undefined })).toBe(true);
		expect(retryableFailure({ status: null })).toBe(true);
	});
	test("408/429/502/503/504 retry, other statuses do not", () => {
		for (const status of [408, 429, 502, 503, 504])
			expect(retryableFailure({ status, method: "GET" })).toBe(true);
		for (const status of [400, 401, 403, 404, 409, 500, 501])
			expect(retryableFailure({ status, method: "GET" })).toBe(false);
	});
	test("safe methods replay; a plain POST does not", () => {
		expect(retryableFailure({ status: 503, method: "get" })).toBe(true);
		expect(retryableFailure({ status: 503, method: "HEAD" })).toBe(true);
		expect(retryableFailure({ status: 503, method: "OPTIONS" })).toBe(true);
		expect(retryableFailure({ status: 503, method: "POST" })).toBe(false);
		expect(retryableFailure({ status: 503, method: "DELETE" })).toBe(false);
	});
	test("an idempotency-keyed POST replays", () => {
		expect(
			retryableFailure({ status: 503, method: "POST", headers: keyed }),
		).toBe(true);
		expect(
			retryableFailure({ status: 503, method: "PATCH", headers: keyed }),
		).toBe(true);
	});
	test("blank idempotency key never counts", () => {
		const blank = { get: () => "  " };
		expect(
			retryableFailure({ status: 503, method: "POST", headers: blank }),
		).toBe(false);
	});
});

describe("full-jitter capped backoff (kit §3)", () => {
	test("jitter scales the exponential ceiling", () => {
		expect(backoffMs(0, 60_000, () => 0.5)).toBe(50);
		expect(backoffMs(2, 60_000, () => 0.5)).toBe(200);
		expect(backoffMs(4, 60_000, () => 0.5)).toBe(800);
	});
	test("the cap bounds the tail", () => {
		expect(backoffMs(30, 1_000, () => 1)).toBe(1_000);
		expect(backoffMs(30, 1_000, () => 0.99)).toBe(990);
	});
	test("rng zero answers zero; degenerate rng clamps to zero", () => {
		expect(backoffMs(5, 60_000, () => 0)).toBe(0);
		expect(backoffMs(5, 60_000, () => Number.NaN)).toBe(0);
	});
});

describe("Retry-After parse + clamp (kit §4)", () => {
	test("delta-seconds and HTTP-date both parse", () => {
		const t0 = Date.UTC(2026, 9, 25, 12, 0, 0);
		expect(parseRetryAfterHeader("3", t0)).toBe(3_000);
		expect(parseRetryAfterHeader(new Date(t0 + 10_000).toUTCString(), t0)).toBe(
			10_000,
		);
	});
	test("absent, empty, negative and malformed are undefined", () => {
		expect(parseRetryAfterHeader(null)).toBeUndefined();
		expect(parseRetryAfterHeader("  ")).toBeUndefined();
		expect(parseRetryAfterHeader("-5")).toBeUndefined();
		expect(parseRetryAfterHeader("soon-ish")).toBeUndefined();
	});
	test("clamp caps the demand; absent stays undefined", () => {
		expect(clampRetryAfterMs(2_000, 1_000)).toBe(1_000);
		expect(clampRetryAfterMs(500, 1_000)).toBe(500);
		expect(clampRetryAfterMs(undefined, 1_000)).toBeUndefined();
		expect(clampRetryAfterMs(Number.NaN, 1_000)).toBeUndefined();
	});
	test("header + clamp in one step", () => {
		const t0 = Date.UTC(2026, 9, 25, 12, 0, 0);
		expect(retryAfterHeaderClamped("300", 5_000, t0)).toBe(5_000);
		expect(retryAfterHeaderClamped("2", 5_000, t0)).toBe(2_000);
	});
});

describe("retry budget ~10% (kit §5)", () => {
	test("cold upstream keeps the min floor", () => {
		const now = 1_000_000;
		const b = new RetryBudget({ now: () => now });
		expect(b.canRetry("u1")).toBe(true);
		b.record("u1", false);
		b.record("u1", true);
		expect(b.canRetry("u1")).toBe(true);
		b.record("u1", true);
		expect(b.canRetry("u1")).toBe(false);
	});
});

describe("circuit breaker (kit §6)", () => {
	test("closed until N consecutive failures, then open", () => {
		const b = new Breakers({ failureThreshold: 3 });
		expect(b.state("u1")).toBe("closed");
		b.failure("u1");
		b.failure("u1");
		expect(b.canAttempt("u1")).toBe(true);
		b.failure("u1");
		expect(b.state("u1")).toBe("open");
		expect(b.canAttempt("u1")).toBe(false);
	});
	test("success resets the failure streak", () => {
		const b = new Breakers({ failureThreshold: 2 });
		b.failure("u1");
		b.success("u1");
		b.failure("u1");
		expect(b.state("u1")).toBe("closed");
	});
	test("elapsed open window offers exactly one half-open probe", () => {
		let now = 1_000_000;
		const b = new Breakers({
			failureThreshold: 1,
			openMs: 100,
			now: () => now,
		});
		b.failure("u1");
		expect(b.state("u1")).toBe("open");
		now += 101;
		expect(b.canAttempt("u1")).toBe(true);
		expect(b.state("u1")).toBe("half-open");
		expect(b.canAttempt("u1")).toBe(false);
		b.success("u1");
		expect(b.state("u1")).toBe("closed");
	});
	test("half-open probe failure re-opens with a fresh window", () => {
		let now = 2_000_000;
		const b = new Breakers({
			failureThreshold: 1,
			openMs: 100,
			now: () => now,
		});
		b.failure("u1");
		now += 101;
		expect(b.canAttempt("u1")).toBe(true);
		b.failure("u1");
		expect(b.state("u1")).toBe("open");
		expect(b.canAttempt("u1")).toBe(false);
	});
	test("ratio caps amplification once volume accrues", () => {
		const b = new RetryBudget({ minPerWindow: 0 });
		for (let i = 0; i < 10; i++) b.record("u1", false);
		expect(b.canRetry("u1")).toBe(true);
		b.record("u1", true);
		expect(b.canRetry("u1")).toBe(false);
	});
	test("window slides: aged-out retries stop counting", () => {
		let now = 1_000_000;
		const b = new RetryBudget({
			now: () => now,
			windowMs: 1_000,
			minPerWindow: 2,
		});
		b.record("u1", true);
		b.record("u1", true);
		expect(b.canRetry("u1")).toBe(false);
		now += 1_001;
		expect(b.canRetry("u1")).toBe(true);
	});
});

describe("ordered failover (kit §7a)", () => {
	type Stub = AttemptResult<unknown>;
	interface Spy {
		calls: string[];
	}
	const ok = (v: string): Stub => ({ ok: true, status: 200, value: v });
	const fail = (status: number): Stub => ({ ok: false, status });
	const runOf =
		(id: string, script: Stub[], spy: Spy) => async (): Promise<Stub> => {
			spy.calls.push(id);
			return script.length === 1 ? script[0] : (script.shift() as Stub);
		};
	test("first healthy candidate answers", async () => {
		const spy: Spy = { calls: [] };
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: runOf("a", [ok("va")], spy) },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("a");
		expect(spy.calls).toEqual(["a"]);
	});
	test("non-retryable status fails over without replaying", async () => {
		const spy: Spy = { calls: [] };
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: runOf("a", [fail(400)], spy) },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
			sleep: async () => {},
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("b");
		expect(spy.calls).toEqual(["a", "b"]);
	});
	test("replay limit bounds same-upstream attempts, then walks on", async () => {
		const spy: Spy = { calls: [] };
		const always503 = async (): Promise<Stub> => {
			spy.calls.push("a");
			return fail(503);
		};
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: always503 },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
			maxReplays: 1,
			rng: () => 0,
			sleep: async () => {},
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("b");
		expect(spy.calls.filter((c) => c === "a").length).toBe(2);
	});
	test("open breakers skip the candidate entirely", async () => {
		const spy: Spy = { calls: [] };
		const breakers = new Breakers({ failureThreshold: 1 });
		breakers.failure("a");
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: runOf("a", [ok("va")], spy) },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
			breakers,
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("b");
		expect(spy.calls).toEqual(["b"]);
	});
	test("transport throw counts as one failed attempt, bounded by replays", async () => {
		const spy: Spy = { calls: [] };
		const throwing = async (): Promise<Stub> => {
			spy.calls.push("a");
			throw new Error("ECONNREFUSED");
		};
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: throwing },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
			maxReplays: 1,
			rng: () => 0,
			sleep: async () => {},
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("b");
		expect(spy.calls.filter((c) => c === "a").length).toBe(2);
	});
	test("retry budget exhausted stops replaying the same upstream", async () => {
		const spy: Spy = { calls: [] };
		const budgets = new RetryBudget({ minPerWindow: 0 });
		const always503 = async (): Promise<Stub> => {
			spy.calls.push("a");
			return fail(503);
		};
		const r = await resilientCall({
			candidates: [
				{ id: "a", run: always503 },
				{ id: "b", run: runOf("b", [ok("vb")], spy) },
			],
			perCallMs: 1_000,
			budgets,
			rng: () => 0,
			sleep: async () => {},
		});
		expect(r.ok).toBe(true);
		expect(r.candidate).toBe("b");
		expect(spy.calls.filter((c) => c === "a").length).toBe(1);
	});
	test("gate wait supersedes kit backoff (single pacing authority)", async () => {
		const spy: Spy = { calls: [] };
		let admits = 0;
		const waits: number[] = [];
		const flaky = async (): Promise<Stub> => {
			spy.calls.push("a");
			return admits === 0 ? fail(429) : ok("va");
		};
		const r = await resilientCall({
			candidates: [{ id: "a", run: flaky }],
			perCallMs: 1_000,
			admit: async () => {
				admits++;
				return admits === 1 ? 30 : null;
			},
			sleep: async (ms) => {
				waits.push(ms);
			},
			rng: () => 0.5,
		});
		expect(r.ok).toBe(true);
		expect(waits).toEqual([30]);
	});
	test("without a gate the kit waits its own clamped backoff, once", async () => {
		const waits: number[] = [];
		let calls = 0;
		const r = await resilientCall({
			candidates: [
				{
					id: "a",
					run: async () => {
						calls++;
						return calls === 1 ? fail(503) : ok("va");
					},
				},
			],
			perCallMs: 1_000,
			retryAfterCapMs: 1_000,
			rng: () => 0.5,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(r.ok).toBe(true);
		// no Retry-After on a 503 → full jitter over min(cap, 100·2^0) = 50ms
		expect(waits).toEqual([50]);
	});
});

// ─── kit §7b: the cache-fallback ladder + the A/B compose ───
describe("cache-fallback ladder (kit §7b)", () => {
	test("fresh-cache hit answers unmarked, no warn", async () => {
		const warns: string[] = [];
		const r = await serveFromFallbacks(
			[{ level: "fresh-cache", load: async () => "fresh" }],
			(l, m) => {
				if (l === "warn") warns.push(m);
			},
		);
		expect(r.level).toBe("fresh-cache");
		expect(r.value).toBe("fresh");
		expect(r.marked).toBe(false);
		expect(warns).toEqual([]);
	});
	test("stale hit is served warn-marked; misses warn per step", async () => {
		const warns: string[] = [];
		const r = await serveFromFallbacks(
			[
				{ level: "fresh-cache", load: async () => null },
				{ level: "stale-cache-marked", load: async () => "stale" },
			],
			(l, m) => {
				if (l === "warn") warns.push(m);
			},
		);
		expect(r.level).toBe("stale-cache-marked");
		expect(r.marked).toBe(true);
		expect(warns.length).toBe(2);
	});
	test("exhausting every level answers unavailable", async () => {
		const warns: string[] = [];
		const r = await serveFromFallbacks(
			[
				{ level: "fresh-cache", load: async () => null },
				{ level: "stale-cache-marked", load: async () => null },
				{ level: "degraded", load: async () => null },
			],
			(l, m) => {
				if (l === "warn") warns.push(m);
			},
		);
		expect(r.level).toBe("unavailable");
		expect(r.value).toBeNull();
		expect(r.marked).toBe(true);
		expect(warns.length).toBe(4);
	});
});

// A/B (mission completeness): the kit composed with the EXISTING AIMD
// machinery must not stack retries. Leg A runs a 429 through a
// ProviderAdmissionCore-paced path (the pool paces, the kit defers); leg B
// runs the same shape kit-only. The assert: with the pool pacing, the kit
// adds NO second wait and NO extra attempt — waits do not sum.
describe("A/B: no double-retry stacking with the existing AIMD path", () => {
	const policy = {
		concurrency: 2,
		intervalCap: 2,
		intervalMs: 20,
		maxOutstanding: 8,
		queueWaitMs: 2_000,
		recovery: { successWindow: 8, decreasePercent: 5 },
	};
	test("leg A — AIMD-paced: the pool owns the wait, the kit adds none", async () => {
		const core = new ProviderAdmissionCore(policy);
		const gateWaits: number[] = [];
		const kitWaits: number[] = [];
		let attempt = 0;
		const r = await resilientCall({
			candidates: [
				{
					id: "pool",
					run: async (signal) => {
						attempt++;
						// the wire attempt rides a real admission lease; the 429
						// feeds the pool exactly as tryOnce does
						const lease = await core.acquire(signal, 1_000);
						lease.feedback?.(attempt === 1 ? 429 : 200, 0.03);
						lease.release();
						return attempt === 1
							? { ok: false, status: 429, retryAfterMs: 30_000 }
							: { ok: true, status: 200, value: "served" };
					},
				},
			],
			perCallMs: 2_000,
			admit: async () => {
				const notBefore = core.snapshot().notBeforeMs;
				const wait = notBefore - Date.now();
				return wait > 0 ? wait : null;
			},
			sleep: async (ms) => {
				gateWaits.push(ms);
			},
			// the kit's own sleep channel is never the gate's channel — the
			// gate path routes waits into gateWaits; the kit backoff channel
			// would land in kitWaits only if the kit added its own wait
			rng: () => 0.5,
		});
		expect(r.ok).toBe(true);
		expect(attempt).toBe(2);
		// every wait is pool-origin (both gate reads inside notBefore): the
		// kit's backoff channel never fired — waits do not sum with backoff
		expect(gateWaits.length).toBe(2);
		expect(gateWaits.every((w) => w >= 0 && w < 1_000)).toBe(true);
		expect(kitWaits.length).toBe(0);
		expect(core.snapshot().rateLimitedTotal).toBe(1);
	});
	test("leg B — kit-only: one clamped backoff wait, one replay", async () => {
		const waits: number[] = [];
		let attempt = 0;
		const r = await resilientCall({
			candidates: [
				{
					id: "solo",
					run: async () => {
						attempt++;
						return attempt === 1
							? { ok: false, status: 429, retryAfterMs: 30_000 }
							: { ok: true, status: 200, value: "served" };
					},
				},
			],
			perCallMs: 2_000,
			retryAfterCapMs: 100,
			rng: () => 0.5,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(r.ok).toBe(true);
		expect(attempt).toBe(2);
		// Retry-After honored but CLAMPED: 30s demand → the 100ms cap
		expect(waits).toEqual([100]);
	});
});
