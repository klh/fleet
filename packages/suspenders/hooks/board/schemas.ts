// hooks/board/schemas.ts — W1303.4 schema-first board API payloads: zod
// schemas are THE definition of the /api/* wire shapes the SPA + machine
// clients consume; types are derived (z.infer), never hand-written.
// Additive: routes keep building payloads as before; these schemas type
// and pin the wire (tests assert live responses against them, so contract
// drift between belt/buckle/board fails loud instead of at render time).
import { z } from "zod";

// ─── /api/tasks (v3 feed — docs/board-api.md) ─────────────────────────────

/** W776 per-item spend attribution (raw numbers; the client formats). */
export const TaskSpendSchema = z.object({
	fresh: z.number(),
	cached: z.number(),
	out: z.number(),
	requests: z.number(),
	wall_ms: z.number(),
	agent_ms: z.number(),
	model_groups: z.record(z.string(), z.unknown()),
});
export type TaskSpend = z.infer<typeof TaskSpendSchema>;

/** W969 Signals-lite verdict badge (newest lane.signal per item). */
export const TaskSignalSchema = z.object({
	class: z.string(),
	confidence: z.number(),
	ts: z.number(),
});
export type TaskSignal = z.infer<typeof TaskSignalSchema>;

/** One work item as the kanban + drawer consume it (tasks.ts taskShape).
 *  Loose by design: execution/tail join per item and evolve with the
 *  board — the named fields are the contract, the rest rides. */
export const TaskShapeSchema = z
	.object({
		project: z.string(),
		id: z.string(),
		title: z.string(),
		state: z.string(),
		failure_note: z.string().nullable(),
		wait_kind: z.string().nullable(),
		wait_reason: z.string().nullable(),
		wait_until_utc: z.string().nullable(),
		owner_sid: z.string().nullable(),
		owner_label: z.string().nullable(),
		origin: z.string().nullable(),
		tag: z.string().nullable(),
		tag_color: z.string().nullable(),
		requires: z.string().nullable(),
		scope: z.string().nullable(),
		parent_id: z.string().nullable(),
		age_s: z.number(),
		created_at_utc: z.string(),
		updated_at_utc: z.string(),
		open_decisions: z.number(),
		signal: z.union([TaskSignalSchema, z.null()]),
		spend: z.union([TaskSpendSchema, z.null()]),
		unblocked_by: z.union([z.string(), z.null()]),
		blocked_by: z.array(z.string()),
		waiting_on: z.array(z.string()),
		executor: z.string().nullable(),
		model: z.string().nullable(),
		locality: z.string().nullable(),
	})
	.loose();
export type TaskShape = z.infer<typeof TaskShapeSchema>;

export const TasksResponseSchema = z.object({
	ok: z.boolean(),
	projects: z.array(z.string()),
	tasks: z.array(TaskShapeSchema),
});
export type TasksResponse = z.infer<typeof TasksResponseSchema>;

// ─── /api/diff (W55 drawer diff) ──────────────────────────────────────────

export const DiffResponseSchema = z.object({
	ok: z.literal(true),
	id: z.string(),
	branch: z.string(),
	base: z.string(),
	stat: z.string(),
	diff: z.string(),
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

export const ApiErrorSchema = z.object({
	ok: z.literal(false),
	error: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ─── /api/tail (W76 live lane tail) ───────────────────────────────────────

/** The bounded .fleet/lane-<sid>.log slice (LANE_TAIL_BYTES cap). */
export const LaneLogSchema = z.object({
	size: z.number(),
	mtime: z.number(),
	truncated: z.boolean(),
	text: z.string(),
});
export type LaneLog = z.infer<typeof LaneLogSchema>;

export const TailResponseSchema = z.object({
	ok: z.literal(true),
	id: z.string(),
	project: z.string(),
	sid: z.union([z.string(), z.null()]),
	log: z.union([LaneLogSchema, z.null()]),
	transcript: z.union([z.string(), z.null()]),
	recent: z.array(z.string()),
});
export type TailResponse = z.infer<typeof TailResponseSchema>;

// ─── /api/prompt/settings (W270 toggles) ──────────────────────────────────

/** The persisted toggle block (suspenders-board.json `prompt.*` keys —
 *  W269-compatible names). The canonical default table lives in
 *  prompt-transform.ts; this is the wire shape. */
export const PromptSettingsSchema = z.object({
	"prompt.condense": z.boolean(),
	"prompt.enhance": z.boolean(),
	"prompt.debug": z.boolean(),
	"prompt.log": z.boolean(),
});
export type PromptSettingsWire = z.infer<typeof PromptSettingsSchema>;

/** POST body: any subset of the toggles (absent keys unchanged). */
export const PromptSettingsPatchSchema = z
	.object({
		"prompt.condense": z.boolean().optional(),
		"prompt.enhance": z.boolean().optional(),
		"prompt.debug": z.boolean().optional(),
		"prompt.log": z.boolean().optional(),
	})
	.strip();
export type PromptSettingsPatch = z.infer<typeof PromptSettingsPatchSchema>;

export const PromptSettingsResponseSchema = z.object({
	ok: z.boolean(),
	settings: PromptSettingsSchema,
});
export type PromptSettingsResponse = z.infer<typeof PromptSettingsResponseSchema>;
