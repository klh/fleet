// bench/artifact/drivers.ts — bed drivers behind one interface. The harness
// core is pure over BedDriver, so CI (bun-only, no Docker) exercises the
// replay-fixture driver; the docker driver is the live bed and is additive.
// The replay driver is FIXTURE material for harness mechanics: its numbers
// are labeled as such and are never ledger rows. Ledger rows come from live
// runs only.

import { seededOrder, type ArmRef, type Caps } from "./types.ts";

export interface BedDriver {
	readonly bed: string;
	readonly caps: Caps;
	/** one measurement of one arm, one rep. May throw — the harness records
	 * the failure as a failed rep, it never invents a number. */
	measure(arm: ArmRef, rep: number, seed: number): Promise<number>;
}

/** deterministic fixture driver: replays a fixed per-arm sample schedule.
 * Used by tests + local harness mechanics runs; NOT a measurement. */
export function replayFixtureDriver(
	caps: Caps,
	fixtures: Record<string, number[]>,
): BedDriver {
	return {
		bed: `${caps.bed}:replay-fixture`,
		caps,
		async measure(arm, rep) {
			const f = fixtures[arm.id];
			if (!f) throw new Error(`no fixture for arm ${arm.id}`);
			const v = f[rep % f.length];
			if (v === undefined)
				throw new Error(`fixture short for ${arm.id}@${rep}`);
			return v;
		},
	};
}

/** execution-order walk: arms in seeded order per rep (controlled ordering —
 * the pairing law at bench scale: order bias averages out over reps). */
export function walkOrder(
	arms: ArmRef[],
	reps: number,
	seed: number,
): Array<{ arm: ArmRef; rep: number }> {
	const walk: Array<{ arm: ArmRef; rep: number }> = [];
	for (let rep = 0; rep < reps; rep++) {
		for (const i of seededOrder(arms.length, seed + rep * 7919)) {
			walk.push({ arm: arms[i]!, rep });
		}
	}
	return walk;
}
