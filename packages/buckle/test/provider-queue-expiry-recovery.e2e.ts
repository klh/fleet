// W2543: queued callers whose admission wait expires before a slot frees
// still happened — real demand the controller must remember across the
// expiry, or a shrunken window can never recover while callers hold short
// budgets (resilience max_queue_wait_ms / remaining walk budget). One
// wait-timer expiry mints ONE bounded demand unit; one healthy current-epoch
// completion spends at most one unit; any 429 erases the evidence. Pure
// in-memory unit fixture — no network, no machine config.
import { expect, test } from "@playwright/test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";

test.describe("@unit", () => {
	const policy = {
		concurrency: 4,
		intervalCap: 100,
		intervalMs: 100,
		maxOutstanding: 16,
		queueWaitMs: 1000,
		recovery: { successWindow: 8, decreasePercent: 5 },
	};

	/** 429-pressure the pool to half its window (AIMD 50%), then wait out
	 * the congestion fence — the state every recovery round starts from. */
	async function pressuredCore() {
		const core = new ProviderAdmissionCore(policy, {
			rateDecreasePercent: 50,
			minConcurrency: 1,
		});
		const seed = await core.acquire();
		seed.feedback?.(429, null);
		seed.release();
		await Bun.sleep(
			Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 2,
		);
		expect(core.snapshot().adaptiveConcurrency).toBe(2);
		return core;
	}

	/** Occupy every current window slot with healthy held leases. */
	async function fillWindow(core: ProviderAdmissionCore) {
		return await Promise.all(
			Array.from({ length: core.snapshot().adaptiveConcurrency }, () =>
				core.acquire(),
			),
		);
	}

	test("expired admission waits leave demand evidence and healthy completions recover the window", async () => {
		test.setTimeout(10_000);
		const core = await pressuredCore();
		for (let round = 0; round < 16; round++) {
			const holders = await fillWindow(core);
			const waiter = core.acquire(undefined, 5).then(
				(lease) => {
					lease.feedback?.(200, null);
					lease.release();
					return "admitted" as const;
				},
				(error) => (error as Error)?.name ?? "unknown",
			);
			await Bun.sleep(40); // the waiter's 5ms budget lapses mid-flight
			// pre-existing fields ONLY through here: this test is the pure
			// behavioral baseline-vs-fixed proof (baseline: adaptiveConcurrency
			// stays 2 forever; fixed: it climbs to the ceiling) — no new
			// snapshot field may gate it (root review, 2 NOV).
			expect(core.snapshot().queued).toBe(0);
			expect(core.snapshot().active).toBe(holders.length); // never started
			for (const holder of holders) {
				holder.feedback?.(200, null);
				holder.release();
			}
			expect(await waiter).toBe("TimeoutError");
			await Bun.sleep(2);
		}
		// 16 expired demands × one healthy completion each: the window climbed
		// back to the operator ceiling gradually — previously it stayed at 2
		// with the recovery counter at 0 forever (root probe, 2 NOV).
		expect(core.snapshot().adaptiveConcurrency).toBe(4);
		expect(core.snapshot().concurrencyCeiling).toBe(4);
		await Bun.sleep(3);
		expect(core.snapshot().outstanding).toBe(0);
	});

	test("no-demand control: healthy completions alone never raise the window", async () => {
		const core = await pressuredCore();
		for (let round = 0; round < 12; round++) {
			const holders = await fillWindow(core);
			await Bun.sleep(8);
			for (const holder of holders) {
				holder.feedback?.(200, null);
				holder.release();
			}
		}
		expect(core.snapshot().adaptiveConcurrency).toBe(2);
		expect(core.snapshot().queueWaitExpiriesTotal).toBe(0);
		expect(core.snapshot().demandCredit).toBe(0);
	});

	test("one expiry buys exactly one recovery credit — a second completion cannot double-spend it", async () => {
		const core = await pressuredCore();
		const holders = await fillWindow(core);
		const waiter = core
			.acquire(undefined, 5)
			.catch((error) => (error as Error).name);
		await Bun.sleep(40);
		expect(await waiter).toBe("TimeoutError");
		expect(core.snapshot().demandCredit).toBe(1);
		for (const holder of holders) {
			holder.feedback?.(200, null);
			holder.release();
		}
		// the first completion spent the unit; the second finds no demand
		expect(core.snapshot().concurrencyRecoverySuccesses).toBe(1);
		expect(core.snapshot().demandCredit).toBe(0);
	});

	test("a fresh 429 erases remembered demand and the streak (stale-epoch fence)", async () => {
		const core = await pressuredCore();
		const holders = await fillWindow(core);
		const waiter = core
			.acquire(undefined, 5)
			.catch((error) => (error as Error).name);
		await Bun.sleep(40);
		expect(await waiter).toBe("TimeoutError");
		expect(core.snapshot().demandCredit).toBe(1);
		holders[0].feedback?.(200, null); // spends the unit: one success
		holders[0].release();
		holders[1].feedback?.(429, null); // genuine rate pressure returns
		holders[1].release();
		await Bun.sleep(2);
		expect(core.snapshot().demandCredit).toBe(0);
		expect(core.snapshot().concurrencyRecoverySuccesses).toBe(0);
		await Bun.sleep(
			Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 2,
		);
		// later healthy completions with no queue and no memory: no recovery
		for (let i = 0; i < 4; i++) {
			const lease = await core.acquire();
			lease.feedback?.(200, null);
			lease.release();
			await Bun.sleep(1);
		}
		expect(core.snapshot().adaptiveConcurrency).toBe(1);
	});

	test("stale demand: an expired credit past the queueWait horizon licenses nothing", async () => {
		// W2543 owner correction — maxOutstanding alone does not bound TIME.
		// The credit is left UNSPENT, holders stay held, and the horizon
		// lapses with NO snapshot() in between (snapshot itself normalizes).
		// The healthy completions that follow must find no live demand.
		const core = await pressuredCore();
		const holders = await fillWindow(core);
		const waiter = core
			.acquire(undefined, 5)
			.catch((error) => (error as Error).name);
		await Bun.sleep(40);
		expect(await waiter).toBe("TimeoutError"); // minted, UNSPENT
		await Bun.sleep(policy.queueWaitMs + 60); // horizon lapses, holders held
		for (const holder of holders) {
			holder.feedback?.(200, null);
			holder.release();
		}
		expect(core.snapshot().demandCredit).toBe(0);
		expect(core.snapshot().concurrencyRecoverySuccesses).toBe(0);
		expect(core.snapshot().adaptiveConcurrency).toBe(2);
	});

	test("a fresh expiry cannot revive a stale unobserved credit", async () => {
		// root review: the expiry callback increments demandCredit directly —
		// without normalizing first, an old unobserved credit would ride a
		// fresh expiry back to life. One fresh expiry credits exactly 1.
		const core = await pressuredCore();
		const holders = await fillWindow(core);
		const stale = core
			.acquire(undefined, 5)
			.catch((error) => (error as Error).name);
		await Bun.sleep(40);
		expect(await stale).toBe("TimeoutError"); // credit 1, never observed
		await Bun.sleep(policy.queueWaitMs + 60); // horizon lapses, NO snapshot
		const fresh = core
			.acquire(undefined, 5)
			.catch((error) => (error as Error).name);
		await Bun.sleep(40);
		expect(await fresh).toBe("TimeoutError");
		// the stale unit died at the fresh expiry: exactly one live unit
		expect(core.snapshot().demandCredit).toBe(1);
		expect(core.snapshot().queueWaitExpiriesTotal).toBe(2);
		for (const holder of holders) {
			holder.feedback?.(200, null);
			holder.release();
		}
		expect(core.snapshot().concurrencyRecoverySuccesses).toBe(1);
		expect(core.snapshot().demandCredit).toBe(0);
		await Bun.sleep(3);
		expect(core.snapshot().outstanding).toBe(0);
	});

	test("caller aborts and fail-fast pause refusals mint no demand", async () => {
		const core = await pressuredCore();
		const holders = await fillWindow(core);
		// caller abort while queued: the caller gave up, demand is not proven
		const abort = new AbortController();
		const aborted = core.acquire(abort.signal).catch((error) => error);
		abort.abort(new Error("caller cancelled"));
		expect((await aborted).message).toBe("caller cancelled");
		// fail-fast: a pause past the caller wait refuses without ever queuing
		holders[0].feedback?.(429, 1);
		const paused = await core.acquire(undefined, 20).catch((error) => error);
		expect(paused.message).toContain("paused past the caller wait");
		expect(core.snapshot().queueWaitExpiriesTotal).toBe(0);
		expect(core.snapshot().demandCredit).toBe(0);
		for (const holder of holders) holder.release();
		await Bun.sleep(3);
		expect(core.snapshot().outstanding).toBe(0);
	});
});
