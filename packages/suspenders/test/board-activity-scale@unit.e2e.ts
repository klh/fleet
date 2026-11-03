// test/board-activity-scale@unit.e2e.ts — W2267.2: deterministic tests for
// the card activity scale helpers (bin aggregation, measured-width window,
// the shared duration scale, clipped-window honesty, saturation). Pure
// functions; browser geometry rides e2e/board-card-activity.spec.ts.
import { expect, test } from "@playwright/test";
import {
	ACTIVITY_BIN_MS,
	ACTIVITY_STEP_PX,
	DURATION_SCALE_MS,
	activityBinMs,
	activityViewportMs,
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
		// W2591: 240px track → 120min viewport at the adaptive 30s rung =
		// 240 slots — the same interval, six times the real bins.
		expect(dense.count).toBe(240);
		expect(dense.slotMs).toBe(30_000);
		expect(dense.startClipped).toBe(true);
		// window end = start + count*bin — the newest point rides the last slot
		expect(dense.windowEnd).toBe((dense.windowStart ?? 0) + 240 * 30_000);
		const short = spectralBins(pts(3), 40 * ACTIVITY_STEP_PX);
		expect(short.startClipped).toBe(false);
		expect(short.windowStart).toBe(T0);
		// short data clips the count to its own span (3 points 3min apart)
		expect(short.count).toBe(13); // ceil(6min/30s) + 1 span bins at 30s
		expect(short.windowEnd).toBe(T0 + 13 * 30_000);
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

	// W2591 — the viewport a width owns (owner correction #103978): the
	// legacy interval (floor(px/6px) × 3min) is the display contract; finer
	// bins multiply WITHIN it, never replace it.
	test("activityViewportMs preserves the legacy interval per width", () => {
		expect(activityViewportMs(360)).toBe(60 * 3 * MIN); // 3h
		expect(activityViewportMs(420)).toBe(70 * 3 * MIN); // 3.5h
		expect(activityViewportMs(600)).toBe(100 * 3 * MIN); // 5h
		expect(activityViewportMs(180)).toBe(30 * 3 * MIN); // 1.5h
	});

	// W2591 — the adaptive rung: finest nice ladder step whose slots fit
	// (≥1px each) within the width's own viewport, never finer than the
	// data's own grain.
	test("activityBinMs picks the finest rung the pixels and data support", () => {
		// per-request precision: ~1px cells at 360px → 30s (owner guidance)
		expect(activityBinMs(360, 1)).toBe(30_000);
		expect(activityBinMs(600, 1)).toBe(30_000);
		// coarse minute history caps the rung at 60s — no fake fine detail
		expect(activityBinMs(360, 60_000)).toBe(60_000);
		// 15s rung needs 720px+ of track for a 6h viewport... at 180px the
		// viewport is 90min → 30s fits (180 slots); 15s would be 360 slots
		// of 0.5px — too thin, so 30s wins even with fine data
		expect(activityBinMs(180, 1)).toBe(30_000);
		expect(activityBinMs(180, 15_000)).toBe(30_000);
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
	// W2591: at the adaptive 30s rung the ±30s pair around midnight now
	// rides ADJACENT 30s slots — distinct real events, never split by the
	// rollover itself; the ±60s DST pair likewise stays two honest bins.
	test("bins hold their grid across UTC midnight and DST fall-back", () => {
		const midnight = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z
		const cross = spectralBins(
			[
				[midnight - 30_000, 1, 0, 0],
				[midnight + 30_000, 2, 0, 0],
			],
			6 * ACTIVITY_STEP_PX,
		);
		// a UTC-day rollover never splits a BIN: each point keeps its own
		// 30s slot (adjacent, floor- and ceil-side of midnight) and both
		// counts survive exactly — no doubling, no collapse
		expect(cross.bins.filter((b) => b !== null)).toHaveLength(2);
		expect(cross.bins.reduce((n, b) => n + (b?.fresh ?? 0), 0)).toBe(3);
		// EU DST fall-back: the repeated local hour is two distinct epochs —
		// the grid keeps 30s slots, both points counted exactly
		const dst = Date.UTC(2023, 9, 29, 1, 0, 0);
		const fb = spectralBins(
			[
				[dst - 60_000, 5, 0, 0],
				[dst + 60_000, 6, 0, 0],
			],
			6 * ACTIVITY_STEP_PX,
		);
		expect(fb.bins.filter((b) => b !== null)).toHaveLength(2);
		expect(fb.bins.reduce((n, b) => n + (b?.fresh ?? 0), 0)).toBe(11);
		expect(fb.slotMs).toBe(30_000);
	});

	// W2591 — the owner ask: multiple requests within one minute stay
	// DISTINCT spikes at a suitable width, and exact totals survive.
	test("same-minute requests render as distinct real bins; sums preserved", () => {
		const B = Math.floor(T0 / 30_000) * 30_000; // aligned to the 30s grid
		const s = spectralBins(
			[
				[B + 10_000, 1000, 0, 100],
				[B + 40_000, 2000, 500, 200],
				[B + 130_000, 3000, 0, 300],
			],
			360,
		);
		expect(s.slotMs).toBe(30_000);
		const real = s.bins.filter((b) => b !== null);
		expect(real).toHaveLength(3); // three requests, three spikes
		const sum = s.bins.reduce(
			(n, b) => n + (b ? b.fresh + b.cached + b.out : 0),
			0,
		);
		expect(sum).toBe(1000 + 0 + 100 + 2000 + 500 + 200 + 3000 + 0 + 300);
	});

	// W2591 — coarse history is never expanded into fake fine samples: a
	// window of minute-grain points renders at 60s (never 30s), and the
	// same interval is shown (viewport preserved, resolution honest).
	test("coarse minute history caps the rung at 60s — viewport preserved", () => {
		const B = Math.floor(T0 / 60_000) * 60_000;
		const coarse: [number, number, number, number, number][] =
			Array.from({ length: 180 }, (_, i) => [B + i * 60_000, 10, 5, 1, 60_000]);
		const s = spectralBins(coarse, 360);
		expect(s.slotMs).toBe(60_000); // never finer than the data's grain
		expect(s.count).toBe(180); // 3h viewport ÷ 60s
		expect(s.bins.filter((b) => b !== null)).toHaveLength(180);
	});

	// W2591 — mixed resolution: one visible coarse point honestly coarsens
	// the WHOLE rung (uniform axis, never per-bin fake detail).
	test("mixed fine+coarse window renders at the coarser rung", () => {
		const B = Math.floor(T0 / 60_000) * 60_000;
		const mixed: [number, number, number, number, number][] = [
			...Array.from(
				{ length: 6 },
				(_, i): [number, number, number, number, number] => [
					B + i * 30_000,
					1,
					1,
					1,
					30_000,
				],
			),
			[B - 60_000, 5, 0, 0, 60_000], // older coarse point INSIDE the window
		];
		const m = spectralBins(mixed, 360);
		expect(m.slotMs).toBe(60_000);
	});

	// W2591 — the displayed horizon is unchanged from the legacy mapping:
	// finer bins multiply WITHIN the interval, never shorten history.
	test("adaptive binning preserves the displayed horizon", () => {
		const px = 360;
		const legacyHorizon = Math.floor(px / ACTIVITY_STEP_PX) * ACTIVITY_BIN_MS;
		const last = T0 + 10 * 60_000;
		const dense = spectralBins(
			Array.from(
				{ length: 400 },
				(_, i) => [last - i * 30_000, 1, 1, 1],
			) as [number, number, number, number][],
			px,
		);
		expect(dense.windowEnd - dense.windowStart).toBeGreaterThanOrEqual(
			legacyHorizon,
		);
		expect(dense.count).toBe(legacyHorizon / 30_000); // 360 real bins
	});
});
