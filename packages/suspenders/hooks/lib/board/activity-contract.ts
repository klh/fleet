// hooks/lib/board/activity-contract.ts — W2267.2: the typed + zod/mini
// contract for <klh-card-activity>, the board card's spectral activity
// plot + duration hairline. The card lane (W2267.4) wires spendSeries and
// attemptData into these properties; the component (hooks/board-html/
// klh-card-activity.ts) renders them. Schema law W1238.4: the wire-facing
// shapes are zod/mini schemas, one source of truth for both faces — the
// FeedStore validator catches drift loud, the server suite parses real
// route payloads through them.
import * as z from "zod/mini";
import { ACTIVITY_BIN_MS, DURATION_SCALE_MS } from "./activity-scale.ts";

/** Raw /api/spend-series point: [ts, fresh, cached, out]. */
export const ActivityPointSchema = z.tuple([
	z.number(),
	z.number(),
	z.number(),
	z.number(),
]);

/** AttemptTimeline (hooks/board/attempt-timeline.ts) — kept opaque here:
 *  the card lane owns wiring; this component passes it through. */
export const AttemptTimelineSchema = z.looseObject({
	windowStart: z.number(),
	windowEnd: z.number(),
});

export const CardActivitySchema = z.looseObject({
	/** raw points, oldest→newest; [] = honest empty. */
	points: z.array(ActivityPointSchema),
	/** elapsed wall ms (spend.wall_ms) — null/0 = hairline invisible. */
	wallMs: z.nullable(z.number()),
	/** AttemptTimeline for the card lane's attempt view; optional. */
	attempt: z.optional(z.nullable(AttemptTimelineSchema)),
});

export type ActivityPoint = z.infer<typeof ActivityPointSchema>;
export type CardActivityData = z.infer<typeof CardActivitySchema>;

/** Semantic helpers shared by the component and its tests: the constants
 *  the card lane needs documented in ONE place (no per-card copies). */
export const ACTIVITY_CONTRACT = {
	/** the design bin: 6px cell ↔ 3 minutes. */
	binMs: ACTIVITY_BIN_MS,
	/** ONE shared duration scale: full card width ↔ 24h (the same horizon
	 *  /api/spend-series serves). No per-card normalization, ever. */
	durationScaleMs: DURATION_SCALE_MS,
	/** the hairline: 1 CSS px tall, zero own margin/padding, directly
	 *  under the plot's bottom edge. */
	hairlinePx: 1,
	/** axis type: ~10px, 11-12px line-height, one line total. */
	axisFontPx: 10,
	axisLineHeightPx: 12,
} as const;
