// lane-capacity@unit.e2e.ts — hub design D4: a lane the shared liveness
// verdict calls live must hold its refill slot even when dispatch-next's
// cwd probe misses it; otherwise refill launches past lane_target.
import { expect, test } from "@playwright/test";
import { liveForCapacity, occupiesSlot } from "../scripts/lib/lane-capacity.ts";
import {
	canAttemptRefill,
	refillWindow,
} from "../scripts/lib/refill-window.ts";

const lanes = [
	{ sid: "a", shared: true, dispatch: true },
	{ sid: "b", shared: true, dispatch: false }, // cwd probe misses a live lane
	{ sid: "c", shared: false, dispatch: true }, // fresh launch inside grace
	{ sid: "d", shared: false, dispatch: false }, // dead
];
const probes = {
	shared: (l) => l.shared,
	dispatch: (l) => l.dispatch,
};

test("either liveness test holds the slot; only the doubly-dead lane frees it", () => {
	expect(lanes.map((l) => occupiesSlot(l, probes))).toEqual([
		true,
		true,
		true,
		false,
	]);
	expect(liveForCapacity(lanes, probes).map((l) => l.sid)).toEqual([
		"a",
		"b",
		"c",
	]);
});

test("refill at target refuses once shared-live lanes are counted", () => {
	const target = 3;
	const live = liveForCapacity(lanes, probes).length;
	const window = refillWindow("steady", target, live, 0);
	expect(canAttemptRefill(window, live)).toBe(false);
	// the old dispatch-only count saw 2 live and would have launched
	const old = lanes.filter((l) => l.dispatch).length;
	expect(canAttemptRefill(refillWindow("steady", target, old, 0), old)).toBe(
		true,
	);
});
