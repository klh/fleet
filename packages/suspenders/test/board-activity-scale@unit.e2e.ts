// test/board-activity-scale@unit.e2e.ts — W2267.2: deterministic tests for
// the card activity scale helpers (bin aggregation, measured-width window,
// the shared duration scale, clipped-window honesty, saturation). Pure
// functions; browser geometry rides e2e/board-card-activity.spec.ts.
import { expect, test } from "@playwright/test";
import {
	ACTIVITY_BIN_MS,
	ACTIVITY_STEP_PX,
	DURATION_SCALE_MS,
	activityWindow,
	binPoints,
	durationSpan,
	fmtDurationExact,
	fmtScaleLabel,
	spectralBins,
} from "../hooks/lib/board/activity-scale.ts";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** points at exactly one slot each, stepping one bin from T0. */
function pts(n: number, t0 = T0): [number, number, number, number][] {
	return Array.from({ length: n }, (_, i) => [
		t0 + i * ACTIVITY_BIN_MS,
		10,
		20,
		5,
	]);
}

test.describe("@unit", () => {
	test("binPoints aggregates same-slot sums and keeps output tokens", () => {
		const b = binPoints(
			[
				[T0, 1, 2, 3],
				[T0 + 1000, 10, 20, 30],
				[T0 + ACTIVITY_BIN_MS, 5, 0, 1],
			],
			T0,
			4,
		);
		expect(b[0]).toEqual({ fresh: 11, cached: 22, out: 33 });
		expect(b[1]).toEqual({ fresh: 5, cached: 0, out: 1 });
		expect(b[2]).toBeNull();
		expect(b[3]).toBeNull();
	});

	test("binPoints: pre-window points drop, newest rides the last bin", () => {
		const b = binPoints(
			[
				[T0 - 5 * ACTIVITY_BIN_MS, 99, 99, 99],
				[T0 + 3 * ACTIVITY_BIN_MS, 1, 1, 1],
				[T0 + 40 * ACTIVITY_BIN_MS + 5000, 7, 0, 0],
			],
			T0,
			40,
		);
		expect(b[0]).toBeNull();
		expect(b[3]).toEqual({ fresh: 1, cached: 1, out: 1 });
		expect(b[39]).toEqual({ fresh: 7, cached: 0, out: 0 });
	});

	test("spectralBins is end-pinned on dense data, left-aligned on short", () => {
		const dense = spectralBins(pts(200), 40 * ACTIVITY_STEP_PX);
		expect(dense.count).toBe(40);
		expect(dense.startClipped).toBe(true);
		// window end = start + count*bin — the newest point rides the last slot
		expect(dense.windowEnd).toBe(
			(dense.windowStart ?? 0) + 40 * ACTIVITY_BIN_MS,
		);
		const short = spectralBins(pts(3), 40 * ACTIVITY_STEP_PX);
		expect(short.startClipped).toBe(false);
		expect(short.windowStart).toBe(T0);
		expect(short.windowEnd).toBe(T0 + 3 * ACTIVITY_BIN_MS);
	});

	test("spectralBins empty input is honest — no window, no fake start", () => {
		const s = spectralBins([], 40 * ACTIVITY_STEP_PX);
		expect(s.bins).toEqual([]);
		expect(s.firstTs).toBeNull();
		expect(s.windowStart).toBeNull();
		expect(s.windowEnd).toBeNull();
		expect(s.hasData).toBe(false);
	});

	test("activityWindow derives bins from the measured track, end-pinned", () => {
		const w = activityWindow(T0 + 10 * ACTIVITY_BIN_MS, 37 * ACTIVITY_STEP_PX);
		expect(w.count).toBe(37);
		expect(w.slotMs).toBe(ACTIVITY_BIN_MS);
		expect(w.end).toBe(T0 + 10 * ACTIVITY_BIN_MS);
		expect(w.start).toBe(T0 + 10 * ACTIVITY_BIN_MS - 37 * ACTIVITY_BIN_MS);
	});

	test("durationSpan grows symmetrically from the midpoint on one scale", () => {
		const s = durationSpan(DURATION_SCALE_MS / 2, 300);
		expect(s.center).toBe(150);
		expect(s.half).toBe(75);
		expect(s.start).toBe(75);
		expect(s.end).toBe(225);
		expect(s.saturated).toBe(false);
		expect(s.visible).toBe(true);
	});

	test("durationSpan saturates honestly; zero/unknown render nothing", () => {
		const over = durationSpan(DURATION_SCALE_MS * 3, 300);
		expect(over.start).toBe(0);
		expect(over.end).toBe(300);
		expect(over.saturated).toBe(true);
		expect(durationSpan(0, 300).visible).toBe(false);
		expect(durationSpan(null, 300).visible).toBe(false);
		expect(durationSpan(undefined, 300).visible).toBe(false);
	});

	test("fmtDurationExact renders wall-clock truth, not progress", () => {
		expect(fmtDurationExact(90 * MIN)).toBe("1h 30m");
		expect(fmtDurationExact(25 * MIN)).toBe("25m");
		expect(fmtDurationExact(0)).toBe("0m");
		expect(fmtScaleLabel()).toBe("24h");
	});

	// Timezone/DST/rollover (ACCEPT): binning is pure epoch arithmetic —
	// slots never shift at a UTC-day boundary or an EU DST fall-back
	// (2023-10-29 01:00Z, clocks 03:00→02:00 CEST): the bin grid is
	// TZ-agnostic by construction and the dual stamps are the lib's
	// (pinned in test/wallclock.test.ts), so no bin doubles or collapses.
	test("bins hold their 3-minute grid across UTC midnight and DST fall-back", () => {
		const midnight = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z
		const cross = spectralBins(
			[
				[midnight - 30_000, 1, 0, 0],
				[midnight + 30_000, 2, 0, 0],
			],
			6 * ACTIVITY_STEP_PX,
		);
		// both points aggregate into ONE midnight-spanning bin — a UTC-day
		// rollover never splits a bin (points exactly one bin apart WOULD
		// ride adjacent slots; ±30s share slot 0 by construction)
		expect(cross.bins.filter((b) => b !== null)).toHaveLength(1);
		expect(cross.bins[0]).toEqual({ fresh: 3, cached: 0, out: 0 });
		// EU DST fall-back: the repeated local hour is two distinct epochs —
		// the grid keeps 3-minute slots, one bin, both points counted
		const dst = Date.UTC(2023, 9, 29, 1, 0, 0);
		const fb = spectralBins(
			[
				[dst - 60_000, 5, 0, 0],
				[dst + 60_000, 6, 0, 0],
			],
			6 * ACTIVITY_STEP_PX,
		);
		expect(fb.bins.filter((b) => b !== null)).toHaveLength(1);
		expect(fb.bins[0]).toEqual({ fresh: 11, cached: 0, out: 0 });
		expect(fb.slotMs).toBe(ACTIVITY_BIN_MS);
	});
});
