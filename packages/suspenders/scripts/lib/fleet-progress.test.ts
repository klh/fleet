import { expect, test } from "bun:test";
import { fleetProgress } from "./fleet-progress.ts";
const now = 4_000_000;
const prior = { progressAt: 1, done: 5, pending: 3 };
test("dead claimed backlog stalls even with READY zero", () => {
	expect(
		fleetProgress(
			{ counts: { CLAIMED: 3, DONE: 5 }, latest_done: null },
			0,
			prior,
			now,
		),
	).toMatchObject({ pending: 3, stalled: true, restart: true });
});
test("real completions reset stall episode and restart budget", () => {
	expect(
		fleetProgress(
			{ counts: { CLAIMED: 2, DONE: 6 }, latest_done: now / 1000 },
			0,
			{ ...prior, progressRestarts: 2 },
			now,
		),
	).toMatchObject({
		stalled: false,
		state: { progressAt: now, progressRestarts: 0 },
	});
});
test("live lanes are active but do not reset work-progress clock", () => {
	expect(
		fleetProgress(
			{ counts: { CLAIMED: 3, DONE: 5 }, latest_done: null },
			1,
			prior,
			now,
		),
	).toMatchObject({ stalled: false, state: { progressAt: 1 } });
});
test("empty graph and first observation have a grace period", () => {
	expect(
		fleetProgress({ counts: {}, latest_done: null }, 0, prior, now).stalled,
	).toBe(false);
	expect(
		fleetProgress({ counts: { CLAIMED: 3 }, latest_done: null }, 0, {}, now)
			.stalled,
	).toBe(false);
});
test("stalled recovery kicks are bounded and spaced", () => {
	const stats = { counts: { CLAIMED: 3, DONE: 5 }, latest_done: null };
	expect(
		fleetProgress(stats, 0, { ...prior, progressRestarts: 2 }, now),
	).toMatchObject({ stalled: true, restart: false });
	expect(
		fleetProgress(stats, 0, { ...prior, restartAt: now - 100 }, now).restart,
	).toBe(false);
});
