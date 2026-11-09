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

/** Raw /api/spend-series point: [ts, fresh, cached, out] or, since W2591,
 *  [ts, fresh, cached, out, binMs] — the 5th element is the point's own
 *  grain (explicit truthful resolution metadata, owner #103978: never
 *  infer it from timestamp gaps). Absent = per-request-precise source. */
export const ActivityPointSchema = z.union([
	z.tuple([
		z.number(),
		z.number(),
		z.number(),
		z.number(),
		z.optional(z.number()),
	]),
]);

/** AttemptTimeline (hooks/board/attempt-timeline.ts), W2267.4.2.1: the
 *  FULL zod/mini wire contract — the wiring leaf parses what the renderer
 *  consumes (segment kinds, boundaries, milestones), drift fails loud.
 *  Field semantics are the backend's own (see its header): firstByteAt is
 *  the first attributed ledger request timestamp, tool segments derive
 *  from request rows, uncovered gaps stay `unknown`. */
export const AttemptSegmentKindSchema = z.enum([
	"queue",
	"firstbyte",
	"tool",
	"pause",
	"unknown",
]);
export const AttemptSegmentSchema = z.object({
	kind: AttemptSegmentKindSchema,
	start: z.number(),
	end: z.number(),
});
export const AttemptMilestoneSchema = z.object({
	ts: z.number(),
	commit: z.string(),
	stage: z.string(),
});
export const AttemptTimelineSchema = z.object({
	windowStart: z.number(),
	windowEnd: z.number(),
	binMs: z.number(),
	bins: z.number(),
	attempt: z.object({
		sid: z.string(),
		index: z.number(),
		claimStart: z.number(),
		claimEnd: z.nullable(z.number()),
		created: z.nullable(z.number()),
		firstByteAt: z.nullable(z.number()),
		segments: z.array(AttemptSegmentSchema),
	}),
	milestones: z.array(AttemptMilestoneSchema),
});

export const CardActivitySchema = z.looseObject({
	/** raw points, oldest→newest; [] = honest empty. 5th element (when
	 *  present) = the point's own grain in ms — coarse archive rows carry
	 *  60000; fine fresh rows carry their bin; absent = request-precise. */
	points: z.array(ActivityPointSchema),
	/** elapsed wall ms (spend.wall_ms) — null/0 = hairline invisible. */
	wallMs: z.nullable(z.number()),
	/** AttemptTimeline for the card lane's attempt view; optional. */
	attempt: z.optional(z.nullable(AttemptTimelineSchema)),
});

export type ActivityPoint = z.infer<typeof ActivityPointSchema>;
export type AttemptSegmentKind = z.infer<typeof AttemptSegmentKindSchema>;
export type AttemptSegment = z.infer<typeof AttemptSegmentSchema>;
export type AttemptMilestone = z.infer<typeof AttemptMilestoneSchema>;
export type AttemptTimeline = z.infer<typeof AttemptTimelineSchema>;
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
	/** the plot height band (owner contract): the spectral strip renders
	 *  40-55 CSS px tall at every card width — never the legacy 28px. */
	plotHeightPx: 40,
} as const;
