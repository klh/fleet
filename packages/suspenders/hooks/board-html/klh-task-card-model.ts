// hooks/board-html/klh-task-card-model.ts — the <klh-task-card> input
// contract (schema law W1238.4): zod/mini derives the TypeScript type, the
// tone vocabulary mirrors the board's workTone map exactly (core.ts is a
// frozen legacy chunk, not importable), and the metric formatters own the
// unknown-≠-zero rule — an absent metric renders "—", never a measured 0.
// One job: pure model + format, no DOM, no I/O.
import * as z from "zod/mini";

/** Board display states → the one tone vocabulary (mirrors core.ts workTone). */
export type TaskTone =
	| "ready"
	| "working"
	| "blocked"
	| "split"
	| "failed"
	| "done"
	| "cancelled";

export function taskTone(state: string): TaskTone {
	if (state === "CLAIMED" || state === "RUNNING") return "working";
	if (state === "WAITING" || state === "BLOCKED" || state === "PAUSED")
		return "blocked";
	if (state === "SHATTERED") return "split";
	if (state === "FAILED") return "failed";
	if (state === "DONE") return "done";
	if (state === "CANCELLED") return "cancelled";
	return "ready";
}

const optStr = z.optional(z.nullable(z.string()));
const optNum = z.optional(z.nullable(z.number()));

/** One executor option for the READY/CLAIMED footer selects. */
export const ExecutorOptionSchema = z.looseObject({
	value: z.string(),
	label: z.string(),
	/** W183.1 bracketed locality badge text ("[L] ", "[HUB] [R] "), pre-built. */
	badge: z.optional(z.string()),
	reasoningEffort: z.optional(z.boolean()),
});
export type ExecutorOption = z.output<typeof ExecutorOptionSchema>;

/** Four metrics; null/undefined = unknown (renders "—"), never 0. */
export const TaskMetricsSchema = z.looseObject({
	tokens: optNum,
	wallMs: optNum,
	tokPerMin: optNum,
	cachePct: optNum,
});
export type TaskMetrics = z.output<typeof TaskMetricsSchema>;

/** W2267.4.1/#100429 — the activity strip contract. The card's bottom
 * `activity` slot hosts ONE component (W2267.2's <klh-card-activity>);
 * `mode` selects spend-bins vs attempt-timeline inside that same component.
 * The card itself renders none of the chart: the wiring lane (W2267.4.2)
 * sets these inputs on the slotted component. Deep chart payloads (bins,
 * segments, milestones) stay the sibling component's own contract. */
export const ActivitySlotModelSchema = z.looseObject({
	mode: z.enum(["spend", "attempt"]),
	/** Visible window (epoch ms) — the shared axis the strip labels. */
	windowStartMs: optNum,
	windowEndMs: optNum,
	/** Bin duration (spend mode) — the honest temporal resolution, no smoothing. */
	binMs: optNum,
	/** Elapsed time on the 1px center-out duration rail (elapsed ≠ progress). */
	elapsedMs: optNum,
	/** The one documented shared board scale the rail spans (ms, full width). */
	scaleMs: optNum,
});
export type ActivitySlotModel = z.output<typeof ActivitySlotModelSchema>;

/** The card's whole reactive input. Loose object: extra wire fields ride
 * through (the board feed carries more than the card reads). */
export const TaskCardModelSchema = z.looseObject({
	id: z.string(),
	project: optStr,
	title: optStr,
	/** Display state (READY/CLAIMED/RUNNING/PAUSED/BLOCKED/FAILED/DONE/
	 * CANCELLED/SHATTERED/WAITING) — the tone derives from it. */
	state: z.string(),
	ageS: optNum,
	/** Quiet mono context line (execution state · proof, wait reason …). */
	context: optStr,
	/** Parent/split reference rendered as a quiet "↳ <ref>" line. */
	parentRef: optStr,
	/** MODEL column value; unknown stays null. */
	model: optStr,
	/** HOST column value (lane label/origin); unknown stays null. */
	host: optStr,
	/** Failure/blocking warning band before the metrics (full reason text). */
	warn: optStr,
	metrics: z.optional(TaskMetricsSchema),
	/** Activity strip inputs for the slotted host (null = no strip). */
	activity: z.optional(ActivitySlotModelSchema),
	/** Nested split child: dashed border + elbow marker. */
	nested: z.optional(z.boolean()),
	/** Configurable semantic perimeter color — independent of the status hue. */
	preferColor: optStr,
	/** Executor catalog + current pick for the footer selects (READY/CLAIMED). */
	executors: z.optional(z.array(ExecutorOptionSchema)),
	executorPick: optStr,
	effortOptions: z.optional(z.array(z.string())),
	effortPick: optStr,
});
export type TaskCardModel = z.output<typeof TaskCardModelSchema>;

/** Card footer actions, carried by TaskCardActionRequestedEvent. `report`
 * asks the mediator to open the item's report view (W2267.4.2 owns the
 * URL/behavior — the card only announces the intent). */
export type TaskCardActionKind =
	| "retry"
	| "recover"
	| "prompt"
	| "start"
	| "reassign"
	| "release"
	| "report";

// --- metric formatters (unknown ≠ 0; "—" when the value is null) ---

export function fmtTokens(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(Math.round(n));
}

export function fmtWall(ms: number | null | undefined): string {
	if (ms == null) return "—";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`; // measured 0 → "0s"
	const m = Math.round(ms / 60_000);
	if (m >= 60)
		return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
	return `${m}m`;
}

export function fmtRate(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function fmtPct(n: number | null | undefined): string {
	if (n == null) return "—";
	return `${Math.round(n)}%`;
}
