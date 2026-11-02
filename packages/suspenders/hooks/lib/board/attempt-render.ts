// hooks/lib/board/attempt-render.ts — W2267.4.2.1: pure attempt-mode
// geometry + inspector text for the card activity strip. No DOM, no Lit —
// the component (hooks/board-html/klh-card-activity.ts) renders what these
// compute, and the deterministic tests pin the semantics:
//   - the attempt rides the SAME strip assembly as spend mode: one 40px
//     plot band, the fixed shared 90-minute attempt window with real
//     boundaries, compact HH:mm axis ends, the 1px duration hairline;
//   - segments map linearly onto the window: queue/firstbyte/tool/pause
//     as distinguishable row marks, unknown gaps stay visibly unknown —
//     color is never the only channel (kind text rides the inspector);
//   - milestones are artifact diamonds pinned to their exact timestamps —
//     never inferred from tokens or a live PID;
//   - provenance is preserved verbatim: firstbyte means first ATTRIBUTED
//     LEDGER REQUEST, tool spans mean REQUEST-ROW minutes, anything else
//     is honestly `unknown` (backend contract, attempt-timeline.ts).
import type { AttemptTimeline } from "./activity-contract.ts";

/** plot band geometry — one shared shape for both strip modes. */
export const ATTEMPT_PLOT_PX = 40;
/** segment marks occupy the mid band; milestones pin above/below. */
const SEG_Y = 13;
const SEG_H = 14;
/** milestone diamond half-width/height in px (artifact diamonds). */
const MS_HALF = 5;

/** Linear window→pixel mapper, clamped into the band. */
export function attemptX(
	t: number,
	windowStart: number,
	windowEnd: number,
	width: number,
): number {
	const span = Math.max(1, windowEnd - windowStart);
	const x = ((t - windowStart) / span) * width;
	return Math.max(0, Math.min(width, x));
}

/** One inspectable hit: a segment, a milestone diamond, or the explicit
 *  no-attempt empty state. Kind text always rides along — color alone is
 *  not a channel (owner correction W2267.4.2.1). */
export interface AttemptHit {
	kind: "queue" | "firstbyte" | "tool" | "pause" | "unknown" | "milestone";
	/** segment [start,end) or the milestone instant. */
	start: number;
	end: number;
	/** milestone-only: exact commit + stage. */
	commit?: string;
	stage?: string;
}

/** Segment rects + milestone diamonds as plain geometry rows (window
 *  clamping happens at hit-test/render time); the SVG namespace/text
 *  join the component's svg`` templates. */
export function attemptRows(a: AttemptTimeline): {
	segs: AttemptHit[];
	milestones: AttemptHit[];
} {
	const segs: AttemptHit[] = [];
	for (const s of a.attempt.segments) {
		if (s.end <= s.start) continue;
		segs.push({ kind: s.kind, start: s.start, end: s.end });
	}
	const milestones: AttemptHit[] = [];
	for (const m of a.milestones) {
		if (m.ts < a.windowStart || m.ts > a.windowEnd) continue;
		milestones.push({
			kind: "milestone",
			start: m.ts,
			end: m.ts,
			commit: m.commit,
			stage: m.stage,
		});
	}
	return { segs, milestones };
}

/** Hit-test one x position against the geometry (milestones first — a
 *  diamond over a segment wins the pointer). */
export function hitTest(
	hits: { segs: AttemptHit[]; milestones: AttemptHit[] },
	x: number,
	windowStart: number,
	windowEnd: number,
	width: number,
): AttemptHit | null {
	for (const m of hits.milestones) {
		const mx = attemptX(m.start, windowStart, windowEnd, width);
		if (Math.abs(x - mx) <= MS_HALF + 1) return m;
	}
	for (const s of hits.segs) {
		const x0 = attemptX(s.start, windowStart, windowEnd, width);
		const x1 = attemptX(s.end, windowStart, windowEnd, width);
		if (x >= x0 && x <= Math.max(x1, x0 + 1)) return s;
	}
	return null;
}

/** Inspector text for one hit — ONE compact human date+time+zone stamp
 *  (owner-approved 2026-11-02: the full dual UTC/local pair repeated three
 *  times per hover was noise), duration, provenance-true kind wording,
 *  milestone commit/stage. */
export function attemptTip(
	hit: AttemptHit,
	attempt: AttemptTimeline,
	stamp: (t: number, t1?: number) => string,
	duration: (ms: number) => string,
): string {
	if (hit.kind === "milestone") {
		return [
			`artifact · ${hit.stage ?? ""}`,
			stamp(hit.start),
			`commit ${hit.commit ?? ""}`,
		].join("\n");
	}
	// #103234: segments carry BOTH endpoints — the stamp callback receives
	// the interval as a unit (t0, t1) and renders the local-zone line +
	// UTC twin itself; a 1-arg stamp degrades to the start instant alone.
	const lines = [
		`${hit.kind} · ${duration(hit.end - hit.start)}`,
		stamp(hit.start, hit.end),
	];
	if (hit.kind === "firstbyte")
		lines.push("first attributed ledger request — not network latency");
	if (hit.kind === "tool")
		lines.push("request-row minutes — not tool-call duration");
	if (hit.kind === "unknown") lines.push("no fact covers this gap");
	lines.push(`attempt ${attempt.attempt.index} · ${attempt.attempt.sid}`);
	return lines.join("\n");
}

export const ATTEMPT_SEG_Y = SEG_Y;
export const ATTEMPT_SEG_H = SEG_H;
export const ATTEMPT_MS_HALF = MS_HALF;
