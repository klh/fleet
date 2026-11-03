// hooks/lib/board/activity-scale.ts — W2267.2: pure data/scale helpers for
// the board card's spectral activity plot + duration hairline. No DOM, no
// Lit — the component (hooks/board-html/klh-card-activity.ts) renders what
// these compute, and the deterministic tests (test/board-activity-scale@
// unit.e2e.ts) pin the semantics:
//   - REAL bins only: points aggregate into fixed 3-minute slots; no
//     smoothing, interpolation or invented temporal resolution;
//   - the window derives from the MEASURED track (W1203 parity): bins =
//     floor(track / step), end-pinned at the newest point, so wider cards
//     show MORE history and the last mark hugs the right edge;
//   - short data left-aligns and reports its TRUE start (startClipped=false)
//     — a clipped window never masquerades as the first-ever request;
//   - the duration hairline rides ONE documented shared board scale
//     (DURATION_SCALE_MS, a full-card-width constant, not per-card
//     normalization): zero/unknown draws nothing, overflow saturates and
//     says so, elapsed time is never progress.
export const ACTIVITY_STEP_PX = 6;
export const ACTIVITY_BAR_PX = 4;
/** The design bin: a 6px cell ↔ 3 minutes — the board's one bin width. */
export const ACTIVITY_BIN_MS = 180_000;
/**
 * The shared duration scale: elapsed wall time that maps to the FULL card
 * width. One documented constant for every card (owner contract 2026-10-29:
 * "choose one documented shared/configurable board scale; no per-card
 * normalization"). 24h — the same horizon /api/spend-series serves.
 */
export const DURATION_SCALE_MS = 24 * 3_600_000;

export interface ActivityBin {
	fresh: number;
	cached: number;
	out: number;
}

/** Aggregate raw [t, fresh, cached, out] points into `count` fixed slots. */
export function binPoints(
	points: readonly [number, number, number, number][],
	start: number,
	count: number,
	_slotMs = ACTIVITY_BIN_MS,
): (ActivityBin | null)[] {
	const bins: (ActivityBin | null)[] = Array.from(
		{ length: count },
		() => null,
	);
	for (const p of points) {
		let slot = Math.floor((p[0] - start) / _slotMs);
		if (slot > count - 1) slot = count - 1; // newest rides the last bin
		if (slot < 0) continue; // pre-window points drop — never pile into bin 0
		let b = bins[slot];
		if (b == null) {
			b = { fresh: 0, cached: 0, out: 0 };
			bins[slot] = b;
		}
		b.fresh += p[1];
		b.cached += p[2];
		b.out += p[3];
	}
	return bins;
}

export interface ActivityWindow {
	count: number;
	slotMs: number;
	start: number;
	end: number;
}

/** The window derives from the MEASURED track: floor(track/step) slots of
 *  ACTIVITY_BIN_MS, end-pinned at the newest point (W1203 parity). */
export function activityWindow(
	newestTs: number,
	trackPx: number,
	stepPx = ACTIVITY_STEP_PX,
	slotMs = ACTIVITY_BIN_MS,
): ActivityWindow {
	const count = Math.max(1, Math.floor(trackPx / stepPx));
	const end = newestTs;
	return { count, slotMs, start: end - count * slotMs, end };
}

export interface SpectralBins {
	bins: (ActivityBin | null)[];
	/** first REAL point (null when there is no data at all). */
	firstTs: number | null;
	windowStart: number | null;
	windowEnd: number | null;
	count: number;
	slotMs: number;
	/** true when the visible start is a clip edge — older points fell out. */
	startClipped: boolean;
	hasData: boolean;
}

const EMPTY_BINS: SpectralBins = {
	bins: [],
	firstTs: null,
	windowStart: null,
	windowEnd: null,
	count: 0,
	slotMs: ACTIVITY_BIN_MS,
	startClipped: false,
	hasData: false,
};

/** Aggregate points into the measured-width, end-pinned spectral bins.
 *  W2267.4.2.1: ONE honest domain — the window the axis LABELS is the
 *  window that is PLOTTED, hoverable and keyboard-walkable. Short data
 *  clips `count` down to its own span, so no blank future bins occupy
 *  the strip's right side (root-proven #100836: 38 real bins labeled to
 *  09:52 while 63 inspect slots walked into empty 11:04+ future). Dense
 *  data keeps the measured width-derived count with older points
 *  clipping out (W1203 parity). */
export function spectralBins(
	points: readonly [number, number, number, number][],
	trackPx: number,
	forceStart?: number,
): SpectralBins {
	if (!points.length) return EMPTY_BINS;
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const p of points) {
		if (p[0] < first) first = p[0];
		if (p[0] > last) last = p[0];
	}
	const w = activityWindow(last, trackPx);
	// end-pinned on dense data (older points clip); short data left-aligns
	// at its own first point and its own span clips the count — never
	// empty future bins, never a labeled end no slot reaches.
	const start = forceStart ?? Math.max(w.start, first);
	const spanBins = Math.ceil((last - start) / w.slotMs) + 1;
	const count = Math.max(1, Math.min(w.count, spanBins));
	return {
		bins: binPoints(points, start, count),
		firstTs: first,
		windowStart: start,
		windowEnd: start + count * w.slotMs,
		count,
		slotMs: w.slotMs,
		startClipped: start > first,
		hasData: true,
	};
}

/** `09:52` — the owner-approved compact local HH:mm for the visible axis
 *  (W2267.4.2.1, root #100723); exact dual UTC/local stamps stay on the
 *  hover/keyboard inspector, never on the axis itself. */
export function fmtHHmm(t: number): string {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DurationSpan {
	visible: boolean;
	center: number;
	half: number;
	start: number;
	end: number;
	/** true when the duration exceeded the shared scale — the line pins at
	 *  full width and says so; never silently renormalizes. */
	saturated: boolean;
}

/** The 1-CSS-px hairline: elapsed wall time on ONE shared board scale,
 *  growing symmetrically from the midpoint. Zero/unknown → invisible. */
export function durationSpan(
	durationMs: number | null | undefined,
	trackPx: number,
	scaleMs = DURATION_SCALE_MS,
): DurationSpan {
	const center = trackPx / 2;
	if (durationMs === null || durationMs === undefined)
		return {
			visible: false,
			center,
			half: 0,
			start: center,
			end: center,
			saturated: false,
		};
	if (!Number.isFinite(durationMs) || durationMs <= 0)
		return {
			visible: false,
			center,
			half: 0,
			start: center,
			end: center,
			saturated: false,
		};
	const half = Math.min(trackPx / 2, (durationMs / scaleMs) * (trackPx / 2));
	return {
		visible: true,
		center,
		half,
		start: center - half,
		end: center + half,
		saturated: durationMs >= scaleMs,
	};
}

/** Exact elapsed time for hover/focus — "1h 30m", never a percentage. */
export function fmtDurationExact(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "24h" — the shared scale's own label (hover/focus + axis center). */
export function fmtScaleLabel(scaleMs = DURATION_SCALE_MS): string {
	return `${scaleMs / 3_600_000}h`;
}
