// hooks/lib/work/lanes-contract.ts — W2269.2: the per-LANE projection of
// the W892 report contract. The lanes view renders lane rows (SID | ITEM |
// ST | TASK | TOKENS | OUT-MIN | MODEL | EFFORT | CONSULT) — this module
// defines the join shape and the PURE row mapping every face renders from.
// One source: items come verbatim from buildReportContract (work-report.ts)
// and the display cells from the SAME exported cell helpers the CLI table
// renders with (work-report-render.ts) — the board never re-implements a
// cell, so CLI and board cannot disagree. Browser-safe: type-only imports
// (erased at bundle time); no node/bun runtime reach-ins here.

import type { ReportItem, ReportSection } from "./work-report.ts";

/** The shared lane-liveness verdict (lib/lanes/lane-liveness.ts vocabulary;
 *  repeated here as a string union so the browser bundle needs no import). */
export type LaneVerdictWord = "alive" | "dead" | "unknown" | null;

/** W2269.2: launch-failure counter + backoff state from the dispatch
 *  intents store (lane_launch_intents + the intent-reprobe fact). Unknown
 *  means no intent row for the item — never a measured 0 attempt count. */
export interface LaneLaunchState {
	/** attempts the dispatcher has burned on this item's launch */
	attempts: number;
	/** intent row state (REGISTERED | FAILED | ...) */
	state: string;
	/** ms until the backoff releases the next launch attempt; null = no
	 *  requeue spec banked (not backing off) */
	requeueInMs: number | null;
}

/** One lane row: the contract item VERBATIM (every view renders FROM it)
 *  plus the lane identity joins the W892 table adds. */
export interface LanesLaneRow {
	sid: string | null;
	/** user-facing lane name (sessions.tags name), else null */
	name: string | null;
	verdict: LaneVerdictWord;
	launch: LaneLaunchState | null;
	/** the W892 contract item — glyph/status/section/usage/model/effort all
	 *  ride this; cells are derived, never hand-computed per view */
	item: ReportItem;
	/** laneDegraded(row) — dead verdict, active backoff, or burned attempts;
	 *  shipped precomputed so every view emphasizes the same rows */
	degraded: boolean;
	/** W2269.2: pre-formatted table cells from the SAME exported helpers the
	 *  CLI table renders with (work-report-render.ts) — the board renders
	 *  these strings verbatim, never re-implements a cell. `—` = unreported. */
	cells: LanesCells;
}

/** The #lanes table cells (SID | ITEM | ST | TASK | TOKENS | OUT-MIN |
 *  MODEL | EFFORT | CONSULT + the launch-failure chip text). */
export interface LanesCells {
	sid: string;
	item: string;
	st: string;
	task: string;
	tokens: string;
	out_min: string;
	model: string;
	effort: string;
	consult: string;
	/** e.g. "launch ×16 · FAILED" — '' when no launch intent row */
	launch: string;
	/** W2794: recent lane.drift alerts for this row's lane class, pre-rendered
	 *  by driftAlertLine — '' when the class is not drifting. Rendered as a
	 *  chip beside the launch chip; every view renders the same string. */
	drift: string;
}

/** The lanes payload: schema_version rides the W892 report contract's
 *  version (the projection is additive, never a second version line). */
export interface LanesContract {
	schema_version: 1;
	generated_at: string;
	project: string;
	now_ms: number;
	stall_ms: number;
	/** §4 actionable-first: rows keep contract order (needs_you → working →
	 *  waiting → done); the counts per section are the section headers */
	sections: Record<ReportSection, number>;
	lanes: LanesLaneRow[];
	totals: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		requests: number;
	};
	/** launch-failure rollup (the failed-N counter the operator scans for):
	 *  lanes with a non-null launch join, and the worst attempt count */
	launch_failures: { lanes: number; worst_attempts: number };
	/** W2794 (review B1-drift-not-surfaced): recent `lane.drift` alerts from
	 *  readDriftAlerts — the ONE row set the board drift card and the #lanes
	 *  chips render from; [] = no drift in the window (not "not checked"). */
	drift: {
		/** per-class alert lines, driftAlertLine-rendered, class order */
		lines: string[];
		/** classes with at least one alert (the chip join key) */
		classes: string[];
	};
}

/** A degraded lane: dead verdict, active launch backoff, or burned
 *  attempts — the rows the view emphasizes (owner directive 2026-11-06). */
export const laneDegraded = (l: LanesLaneRow): boolean =>
	l.verdict === "dead" ||
	(l.launch !== null &&
		(l.launch.attempts > 0 || l.launch.requeueInMs !== null));
