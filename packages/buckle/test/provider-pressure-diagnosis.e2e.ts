import { expect, test } from "@playwright/test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";

test.describe({ tag: "@unit" }, () => {
	type Pressure = "concurrency" | "rate";
	async function run(
		typed: boolean,
		serviceMs: number,
		wall: "occupancy" | "rate" | "mixed",
	) {
		const core = new ProviderAdmissionCore({
			concurrency: 50,
			intervalCap: 1,
			intervalMs: 1,
			maxOutstanding: 80,
			queueWaitMs: 5000,
			recovery: { successWindow: 8, decreasePercent: 5 },
		});
		let active = 0,
			peak = 0,
			accepted = 0,
			refused = 0,
			sequence = 0,
			lastAccepted = 0;
		const waits: number[] = [];
		const start = Date.now();
		await Promise.all(
			Array.from({ length: 40 }, async () => {
				for (let turn = 0; turn < 2; turn++) {
					let complete = false;
					for (let n = 0; n < 30 && !complete; n++) {
						const queued = Date.now(),
							lease = await core.acquire();
						waits.push(Date.now() - queued);
						const now = Date.now();
						const order = sequence++;
						const pressure: Pressure | null =
							wall !== "rate" && active >= 3
								? "concurrency"
								: wall !== "occupancy" && now - lastAccepted < 5
									? "rate"
									: null;
						const feedback = lease.feedback as (
							status: number,
							retry: number | null,
							pressure?: Pressure,
						) => void;
						if (pressure) {
							refused++;
							await Bun.sleep(
								Math.max(
									1,
									Math.round(serviceMs * (0.07 + (order % 4) * 0.04)),
								),
							);
							feedback(429, null, typed ? pressure : undefined);
							lease.release();
						} else {
							active++;
							peak = Math.max(peak, active);
							lastAccepted = now;
							await Bun.sleep(
								Math.round(serviceMs * (0.8 + (order % 5) * 0.1)),
							);
							active--;
							accepted++;
							feedback(200, null);
							lease.release();
							complete = true;
						}
					}
					expect(complete).toBe(true);
				}
			}),
		);
		await Bun.sleep(5);
		waits.sort((a, b) => a - b);
		return {
			typed,
			serviceMs,
			wall,
			accepted,
			refused,
			peak,
			elapsedMs: Date.now() - start,
			p95WaitMs: waits[Math.floor(waits.length * 0.95)],
			snapshot: core.snapshot(),
		};
	}

	test("matched forty-caller pressure shapes retain queue and refusal evidence", async () => {
		const results = [];
		for (const serviceMs of [8, 20, 50])
			for (const wall of ["occupancy", "rate", "mixed"] as const) {
				const baseline = await run(false, serviceMs, wall),
					candidate = await run(true, serviceMs, wall);
				for (const r of [baseline, candidate]) {
					expect(r.accepted).toBe(80);
					expect(r.peak).toBeLessThanOrEqual(wall === "rate" ? 50 : 3);
					expect(r.snapshot.outstanding).toBe(0);
					expect(r.refused).toBeLessThan(80);
				}
				results.push({ baseline, candidate });
			}
		console.info(
			JSON.stringify({
				fixture:
					"matched forty-caller pressure shapes, 9a67-compatible untyped baseline",
				results,
			}),
		);
	}, 60000);
});
