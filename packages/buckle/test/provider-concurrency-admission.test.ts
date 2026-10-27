import { expect, test } from "bun:test";
import { parsePolicy } from "../src/policy.ts";
import {
	bindProviderLease,
	ProviderAdmissionCore,
	providerPressureOf,
} from "../src/provider-admission-core.ts";
import { Router } from "../src/router.ts";

const policy = {
	concurrency: 6,
	intervalCap: 6,
	intervalMs: 1,
	maxOutstanding: 40,
	queueWaitMs: 1000,
	recovery: { successWindow: 8, decreasePercent: 5 },
};

test("Router classifies a configured code as concurrency only on explicit provider evidence", async () => {
	// W1257: Z.ai 1302 "Rate limit reached for requests" collapsed the live
	// spoke pool to 1/50 — a configured code counts ONLY when the provider's
	// own message carries explicit concurrency evidence; otherwise it paces
	// (rate), never collapsing the window
	for (const [message, concurrency] of [
		["Rate limit reached for requests", false],
		["Too many concurrent requests, please retry later", true],
	] as const) {
		const router = new Router(
			parsePolicy(
				JSON.stringify({
					gateway: {
						num_retries: 0,
						provider_pools: {
							account: { ...policy, concurrencyErrorCodes: ["1302"] },
						},
					},
				}),
			),
			{
				pool: {
					groups: () => ["fixture"],
					deployments: () => [
						{
							group: "fixture",
							url: "https://fixture.invalid",
							dialect: "openai",
							adapter_config: { provider_pool: "account" },
						},
					],
				},
				fetchImpl: async () =>
					Response.json(
						{
							error: {
								message: `AnthropicException - ${JSON.stringify({ error: { code: "1302", type: "rate_limit_error", message } })}`,
							},
						},
						{ status: 429 },
					),
			},
		);
		await router.execute({
			group: "fixture",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "fixture" },
			key: "",
		});
		const snapshot = router.providerAdmissionSnapshot().account;
		expect(snapshot?.concurrencyLimitedTotal).toBe(concurrency ? 1 : 0);
		expect(snapshot?.adaptiveConcurrency).toBe(concurrency ? 1 : 6);
		expect(snapshot?.adaptiveGapMs).toBe(concurrency ? 1 : 2);
	}
});

test("only explicit per-account codes classify concurrency pressure", () => {
	expect(providerPressureOf(policy, "1302")).toBe("rate");
	// W1257: even a configured code needs the provider's own concurrency words
	expect(
		providerPressureOf({ ...policy, concurrencyErrorCodes: ["1302"] }, 1302),
	).toBe("rate");
	expect(
		providerPressureOf(
			{ ...policy, concurrencyErrorCodes: ["1302"] },
			1302,
			"too many concurrent requests, please retry",
		),
	).toBe("concurrency");
	expect(
		providerPressureOf({ ...policy, concurrencyErrorCodes: ["1302"] }, "1113"),
	).toBe("rate");
	for (const codes of [
		["1302", "1302"],
		["bad code"],
		[1],
		Array.from({ length: 17 }, (_, i) => String(i)),
	])
		expect(
			() =>
				new ProviderAdmissionCore({
					...policy,
					concurrencyErrorCodes: codes,
				} as never),
		).toThrow();
});

test("one delayed failure burst lowers occupancy without spacing all starts or cancelling leases", async () => {
	const core = new ProviderAdmissionCore(policy);
	const leases = await Promise.all(
		Array.from({ length: 6 }, () => core.acquire()),
	);
	leases[3].feedback?.(429, null, "concurrency");
	const epoch = core.snapshot().feedbackEpoch;
	for (const lease of leases.slice(4))
		lease.feedback?.(429, null, "concurrency");
	for (const lease of leases.slice(0, 3)) lease.feedback?.(200, null);
	expect(core.snapshot().adaptiveConcurrency).toBe(3);
	expect(core.snapshot().adaptiveGapMs).toBe(core.snapshot().baseGapMs);
	expect(core.snapshot().active).toBe(6);
	expect(core.snapshot().feedbackEpoch).toBe(epoch);
	for (const lease of leases) lease.release();
	await Bun.sleep(12);
	for (let i = 0; i < 10; i++) {
		const l = await core.acquire();
		l.feedback?.(200, null);
		l.release();
		await Bun.sleep(1);
	}
	expect(core.snapshot().adaptiveConcurrency).toBe(3); // no queued demand
	await Promise.all(
		Array.from({ length: 20 }, async () => {
			const l = await core.acquire();
			await Bun.sleep(2);
			l.feedback?.(200, null);
			l.release();
		}),
	);
	expect(core.snapshot().adaptiveConcurrency).toBeGreaterThan(3);
	expect(core.snapshot().adaptiveConcurrency).toBeLessThanOrEqual(6);
	await Bun.sleep(2);
	expect(core.snapshot().outstanding).toBe(0);
});

test("mixed in-flight pressure coalesces independently while stale successes cannot recover either control", async () => {
	for (const first of ["rate", "concurrency"] as const) {
		const core = new ProviderAdmissionCore(policy);
		const leases = await Promise.all(
			Array.from({ length: 6 }, () => core.acquire()),
		);
		const second = first === "rate" ? "concurrency" : "rate";
		leases[3].feedback?.(429, null, first);
		leases[4].feedback?.(429, null, second);
		const pressured = core.snapshot();
		expect(pressured.feedbackEpoch).toBe(2);
		expect(pressured.adaptiveGapMs).toBe(pressured.baseGapMs * 2);
		expect(pressured.adaptiveConcurrency).toBe(first === "concurrency" ? 3 : 4);
		for (const lease of leases) {
			lease.feedback?.(429, null, first);
			lease.feedback?.(429, null, second);
			lease.feedback?.(200, null);
			lease.release();
		}
		expect(core.snapshot().feedbackEpoch).toBe(2);
		expect(core.snapshot().adaptiveConcurrency).toBe(
			pressured.adaptiveConcurrency,
		);
		expect(core.snapshot().adaptiveGapMs).toBe(pressured.adaptiveGapMs);
		await Bun.sleep(3);
		expect(core.snapshot().outstanding).toBe(0);
	}
});

test("typed pressure retains full Retry-After and caller cancellation bounds", async () => {
	const core = new ProviderAdmissionCore(policy);
	const lease = await core.acquire();
	lease.feedback?.(429, 1, "concurrency");
	const started = Date.now();
	await expect(core.acquire(undefined, 20)).rejects.toMatchObject({
		name: "TimeoutError",
	});
	expect(Date.now() - started).toBeLessThan(200);
	expect(core.snapshot().notBeforeMs).toBeGreaterThan(started + 800);
	const abort = new AbortController();
	const waiting = core.acquire(abort.signal);
	abort.abort();
	await expect(waiting).rejects.toBeDefined();
	expect(core.snapshot().active).toBe(1);
	lease.release();
	await Bun.sleep(5);
	expect(core.snapshot().outstanding).toBe(0);
});

test("forty queued callers keep FIFO through typed pressure, cancellation and variable service", async () => {
	const core = new ProviderAdmissionCore({ ...policy, maxOutstanding: 50 });
	const holders = await Promise.all(
		Array.from({ length: 6 }, () => core.acquire()),
	);
	holders[3].feedback?.(429, null, "concurrency");
	const starts: number[] = [];
	let active = 0;
	let peak = 0;
	const waiting = Array.from({ length: 40 }, (_, index) => {
		const abort = new AbortController();
		const request = core.acquire(abort.signal).then(
			async (lease) => {
				starts.push(index);
				peak = Math.max(peak, ++active);
				await Bun.sleep(2 + (index % 3));
				active--;
				// Non-healthy completions do not increase the occupied window.
				lease.feedback?.(500, null);
				lease.release();
				return "served";
			},
			() => "cancelled",
		);
		if (index % 7 === 0) abort.abort();
		return request;
	});
	for (const lease of holders) lease.release();
	const outcomes = await Promise.all(waiting);
	expect(outcomes.filter((outcome) => outcome === "cancelled")).toHaveLength(6);
	expect(starts).toEqual(
		Array.from({ length: 40 }, (_, index) => index).filter(
			(index) => index % 7 !== 0,
		),
	);
	expect(peak).toBeLessThanOrEqual(3);
	await Bun.sleep(3);
	expect(core.snapshot().outstanding).toBe(0);
});

test("transport health feedback waits for EOF and excludes cancelled streams", async () => {
	const events: string[] = [];
	let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const response = bindProviderLease(
		new Response(
			new ReadableStream({
				start(c) {
					upstream = c;
				},
			}),
		),
		{
			feedback: () => events.push("healthy"),
			release: () => events.push("release"),
		},
	);
	expect(events).toEqual([]);
	upstream?.enqueue(new Uint8Array([1]));
	const reader = response.body?.getReader();
	await reader?.read();
	expect(events).toEqual([]);
	upstream?.close();
	await reader?.read();
	expect(events).toEqual(["healthy", "release"]);
	const cancelled: string[] = [];
	const other = bindProviderLease(new Response(new ReadableStream()), {
		feedback: () => cancelled.push("healthy"),
		release: () => cancelled.push("release"),
	});
	await other.body?.cancel();
	expect(cancelled).toEqual(["release"]);
});

test("a caller-aborted granted lease cannot later supply healthy EOF feedback", async () => {
	const core = new ProviderAdmissionCore(policy);
	const initial = await core.acquire();
	initial.feedback?.(429, null);
	initial.release();
	await Bun.sleep(15);
	const abort = new AbortController();
	const lease = await core.acquire(abort.signal);
	abort.abort();
	lease.feedback?.(200, null);
	expect(core.snapshot().recoverySuccesses).toBe(0);
	await Bun.sleep(3);
	expect(core.snapshot().outstanding).toBe(0);
});
