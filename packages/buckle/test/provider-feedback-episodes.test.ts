import { expect, test } from "bun:test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";

const policy = {
	concurrency: 50,
	intervalCap: 1,
	intervalMs: 2,
	maxOutstanding: 128,
	queueWaitMs: 4000,
	recovery: { successWindow: 8, decreasePercent: 5 },
};

test("forty callers complete 202 useful turns around fourteen delayed pressure signals", async () => {
	const core = new ProviderAdmissionCore(policy);
	let attempts = 0,
		useful = 0,
		rejected = 0,
		peakGap = 0;
	const waits: number[] = [];
	await Promise.all(
		Array.from({ length: 40 }, async (_, caller) => {
			for (let turn = 0; turn < (caller < 2 ? 6 : 5); turn++) {
				let answered = false;
				for (let retry = 0; retry < 20 && !answered; retry++) {
					const queued = Date.now(),
						lease = await core.acquire();
					waits.push(Date.now() - queued);
					const ordinal = ++attempts;
					// Measured shape, scaled 1:50: 100ms starts, 0.5–0.7s
					// feedback, initial wave plus two later isolated refusals.
					await Bun.sleep(10 + (ordinal % 5));
					answered = ordinal > 12 && ordinal !== 100 && ordinal !== 180;
					if (answered) useful++;
					else rejected++;
					lease.feedback?.(answered ? 200 : 429, null);
					peakGap = Math.max(peakGap, core.snapshot().adaptiveGapMs);
					lease.release();
				}
				expect(answered).toBe(true);
			}
		}),
	);
	await Bun.sleep(5);
	waits.sort((a, b) => a - b);
	const p95 = waits[Math.floor(waits.length * 0.95)];
	console.info(
		JSON.stringify({
			fixture: "delayed pressure 40 callers",
			useful,
			rejected,
			peakGap,
			p95QueueMs: p95,
			snapshot: core.snapshot(),
		}),
	);
	expect(useful).toBe(202);
	expect(rejected).toBe(14);
	expect(peakGap).toBeLessThanOrEqual(32);
	expect(p95).toBeLessThan(1000);
	expect(core.snapshot().outstanding).toBe(0);
}, 15_000);

test("fresh RetryAfter survives coalescing and stale successful feedback", async () => {
	const core = new ProviderAdmissionCore({ ...policy, intervalMs: 10 });
	const old = await core.acquire(),
		first = await core.acquire();
	first.feedback?.(429, null);
	first.release();
	const fresh = await core.acquire();
	fresh.feedback?.(429, 0.15);
	const embargo = core.snapshot().notBeforeMs;
	old.feedback?.(200, null);
	old.release();
	fresh.release();
	expect(core.snapshot().notBeforeMs).toBe(embargo);
	expect(core.snapshot().recoverySuccesses).toBe(0);
	const started = Date.now(),
		lease = await core.acquire();
	expect(Date.now() - started).toBeGreaterThanOrEqual(130);
	lease.release();
});

test("idle time and an old partial healthy streak cannot erase fresh pressure", async () => {
	const core = new ProviderAdmissionCore(policy);
	const first = await core.acquire();
	first.feedback?.(429, null);
	first.release();
	await Bun.sleep(
		Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 10,
	);
	const pressuredGap = core.snapshot().adaptiveGapMs;
	expect(pressuredGap).toBe(4); // Time passing is not successful evidence.
	for (let n = 0; n < 7; n++) {
		const lease = await core.acquire();
		lease.feedback?.(200, null);
		lease.release();
	}
	expect(core.snapshot().recoverySuccesses).toBe(7);
	const stale = await core.acquire(),
		pressure = await core.acquire();
	pressure.feedback?.(429, null);
	pressure.release();
	const gap = core.snapshot().adaptiveGapMs;
	stale.feedback?.(200, null);
	stale.release();
	expect(core.snapshot().recoverySuccesses).toBe(0);
	expect(core.snapshot().adaptiveGapMs).toBe(gap);
});
