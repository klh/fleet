import { expect, test } from "bun:test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { parsePolicy } from "../src/policy.ts";

test("account recovery configuration is explicit and bounded", () => {
	const policy = {
		concurrency: 50,
		intervalCap: 1,
		intervalMs: 5,
		maxOutstanding: 128,
		queueWaitMs: 1800,
	};
	expect(
		() =>
			new ProviderAdmissionCore({
				...policy,
				recovery: { successWindow: 8, decreasePercent: 20 },
			}),
	).not.toThrow();
	for (const recovery of [
		undefined,
		{},
		{ successWindow: 0, decreasePercent: 20 },
		{ successWindow: 8, decreasePercent: 100 },
		{ successWindow: 8, decreasePercent: 1.5 },
		{ successWindow: 8, decreasePercent: 20, extra: 1 },
	]) {
		expect(
			() => new ProviderAdmissionCore({ ...policy, recovery } as never),
		).toThrow();
	}
});

test("authoritative pool configuration refuses omitted recovery instead of choosing a fallback", () => {
	const pool = {
		concurrency: 50,
		intervalCap: 1,
		intervalMs: 500,
		maxOutstanding: 128,
		queueWaitMs: 180000,
	};
	const policy = (recovery?: object) =>
		JSON.stringify({
			gateway: {
				provider_pools: {
					account: { ...pool, ...(recovery ? { recovery } : {}) },
				},
			},
		});
	expect(() => parsePolicy(policy())).toThrow(/explicit bounded recovery/);
	expect(
		parsePolicy(policy({ successWindow: 8, decreasePercent: 5 })).provider_pools
			?.account.recovery,
	).toEqual({ successWindow: 8, decreasePercent: 5 });
});

test("two isolated rate-limit epochs retain most pacing after forty fast successes", async () => {
	// 1:100 time scale of the installed 500ms base; no provider or machine state.
	const core = new ProviderAdmissionCore({
		concurrency: 50,
		intervalCap: 1,
		intervalMs: 5,
		maxOutstanding: 128,
		queueWaitMs: 1800,
		recovery: { successWindow: 8, decreasePercent: 5 },
	});
	for (let epoch = 0; epoch < 2; epoch++) {
		const lease = await core.acquire();
		lease.feedback?.(429, null);
		lease.release();
	}
	expect(core.snapshot().adaptiveGapMs).toBe(20);
	let peakActive = 0;
	const waits = await Promise.all(
		Array.from({ length: 40 }, async () => {
			const queuedAt = Date.now();
			const lease = await core.acquire();
			peakActive = Math.max(peakActive, core.snapshot().active);
			const waited = Date.now() - queuedAt;
			lease.feedback?.(200, null);
			lease.release();
			return waited;
		}),
	);
	await Bun.sleep(5);
	expect(core.snapshot().adaptiveGapMs).toBeCloseTo(20 * 0.95 ** 5, 8);
	expect(core.snapshot().outstanding).toBe(0);
	expect(peakActive).toBeLessThan(50);
	expect(Math.max(...waits)).toBeGreaterThan(500);
}, 5000);

async function compareRun(decreasePercent: number, providerGapMs = 0) {
	const core = new ProviderAdmissionCore({
		concurrency: 50,
		intervalCap: 1,
		intervalMs: 5,
		maxOutstanding: 128,
		queueWaitMs: 3000,
		recovery: { successWindow: 8, decreasePercent },
	});
	for (let n = 0; n < 2; n++) {
		const lease = await core.acquire();
		lease.feedback?.(429, null);
		lease.release();
	}
	let lastAccepted = 0,
		accepted = 0,
		rejected = 0;
	const waits: number[] = [],
		started = Date.now();
	await Promise.all(
		Array.from({ length: 40 }, async () => {
			for (let turn = 0; turn < 3; turn++) {
				let complete = false;
				for (let attempt = 0; attempt < 20 && !complete; attempt++) {
					const queuedAt = Date.now(),
						lease = await core.acquire();
					waits.push(Date.now() - queuedAt);
					const now = Date.now();
					complete = !providerGapMs || now - lastAccepted >= providerGapMs;
					if (complete) {
						lastAccepted = now;
						accepted++;
					} else rejected++;
					lease.feedback?.(complete ? 200 : 429, null);
					lease.release();
				}
				expect(complete).toBe(true);
			}
		}),
	);
	await Bun.sleep(5);
	waits.sort((a, b) => a - b);
	return {
		accepted,
		rejected,
		elapsedMs: Date.now() - started,
		p95WaitMs: waits[Math.floor(waits.length * 0.95)],
		snapshot: core.snapshot(),
	};
}

test("explicit recovery horizon trades queue dwell against actual provider refusals", async () => {
	const oldTransient = await compareRun(5),
		middleTransient = await compareRun(10),
		newTransient = await compareRun(20);
	expect(newTransient.accepted).toBe(oldTransient.accepted);
	expect(newTransient.rejected).toBe(0);
	expect(newTransient.p95WaitMs).toBeLessThan(oldTransient.p95WaitMs as number);
	const oldLimited = await compareRun(5, 15),
		middleLimited = await compareRun(10, 15),
		newLimited = await compareRun(20, 15);
	for (const r of [
		oldTransient,
		middleTransient,
		newTransient,
		oldLimited,
		middleLimited,
		newLimited,
	]) {
		expect(r.accepted).toBe(120);
		expect(r.snapshot.outstanding).toBe(0);
		expect(r.rejected).toBeLessThan(30);
	}
	console.info(
		JSON.stringify({
			fixture: "scaled admission recovery comparison",
			oldTransient,
			middleTransient,
			newTransient,
			oldLimited,
			middleLimited,
			newLimited,
		}),
	);
}, 15000);
