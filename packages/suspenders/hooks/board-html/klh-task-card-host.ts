// hooks/board-html/klh-task-card-host.ts — W2267.4.2.2: the kanban's Lit
// card host (light DOM, engineering standard: data down, events up). The
// legacy string chunk hands it ONE feed task; the host validates it
// through the named wire contract (KanbanTaskSchema — the shared
// TaskShape vocabulary of hooks/board/schemas.ts, in zod/mini for the
// client bundle), derives the card model, composes the approved 09 card
// (<klh-task-card>) with the ONE activity strip (<klh-card-activity>) in
// its slot, and lets the card's typed events bubble composed to the
// kanban's delegated handlers. Renders no chrome of its own:
// display:contents keeps the kanban column layout untouched.
import { css, html, LitElement } from "lit";
import * as z from "zod/mini";
import type {
	ActivityPoint,
	AttemptTimeline,
} from "../lib/board/activity-contract.ts";
import {
	type ExecutorOption,
	type TaskCardModel,
	TaskCardModelSchema,
	type TaskMetrics,
} from "./klh-task-card-model.ts";
import "./klh-task-card.ts";
import "./klh-card-activity.ts";

declare global {
	interface HTMLElementTagNameMap {
		"klh-task-card-host": KlhTaskCardHost;
	}
}

// ── the named incoming feed shape (schema law: parse at the boundary) ──

const nullableStr = z.optional(z.nullable(z.string()));
const optNum = z.optional(z.nullable(z.number()));

/** Per-item spend attribution as the card reads it. */
export const KanbanTaskSpendSchema = z.looseObject({
	fresh: optNum,
	cached: optNum,
	out: optNum,
	wall_ms: optNum,
	/** model → attributed requests; the display model derives from it. */
	model_groups: z.optional(z.record(z.string(), z.unknown())),
});
export type KanbanTaskSpend = z.output<typeof KanbanTaskSpendSchema>;

/** The execution join (observed harness state, one row per claim) — mirrors
 * hooks/lib/work/work-execution.ts's workExecution() return: epoch-ms
 * observed_at, progress = one ArtifactEvidence row or null. */
const KanbanExecutionSchema = z.looseObject({
	state: z.string(),
	observed_at: optNum,
	source: nullableStr,
	progress: z.optional(
		z.nullable(
			z.looseObject({
				stage: z.enum(["completed", "reviewed", "review-blocked", "landed"]),
				ts: optNum,
			}),
		),
	),
});

/** One lane tail slice. */
const KanbanTailSchema = z.looseObject({ text: nullableStr });

/** The kanban card's whole incoming task shape (loose: extra fields ride). */
export const KanbanTaskSchema = z.looseObject({
	id: z.string(),
	project: nullableStr,
	title: nullableStr,
	state: z.string(),
	age_s: optNum,
	owner_sid: nullableStr,
	owner_label: nullableStr,
	origin: nullableStr,
	model: nullableStr,
	locality: nullableStr,
	parent_id: nullableStr,
	tag_color: nullableStr,
	failure_note: nullableStr,
	wait_kind: nullableStr,
	wait_reason: nullableStr,
	requires: nullableStr,
	blocked_by: z.optional(z.array(z.string())),
	waiting_on: z.optional(z.array(z.string())),
	spend: z.optional(z.nullable(KanbanTaskSpendSchema)),
	execution: z.optional(z.nullable(KanbanExecutionSchema)),
	tail: z.optional(z.nullable(KanbanTailSchema)),
});
export type KanbanTask = z.output<typeof KanbanTaskSchema>;

/** What the legacy chunk polls in per card (loose wire shape, snake_case
 * feed fields — the host maps, never the string chunk). */
export interface TaskCardHostInput {
	t: Record<string, unknown> | null;
	executors: ExecutorOption[];
	executorPick: string;
	effortOptions: string[];
	series: ActivityPoint[] | null;
	attempt: AttemptTimeline | null;
	attemptView: boolean;
}

export class KlhTaskCardHost extends LitElement {
	static override properties = {
		t: { attribute: false },
		executors: { attribute: false },
		executorPick: { attribute: false },
		effortOptions: { attribute: false },
		series: { attribute: false },
		attempt: { attribute: false },
		attemptView: { attribute: false },
		/** #103127: the verb the mediator holds in flight — data-down; the
		 * card's footer disables that verb and shows busy text until the
		 * mediator clears it. Never derived from the feed. */
		pendingAction: { attribute: false },
		/** Root #103404: the page-banked unsubmitted picks — re-hydrated on
		 * the host after a structural rebuild (the previous card's own draft
		 * fields died with it). Undefined keys mean "no banked draft". */
		draftPick: { attribute: false },
		draftEffort: { attribute: false },
	};

	declare t: Record<string, unknown> | null;
	declare executors: ExecutorOption[];
	declare executorPick: string;
	declare effortOptions: string[];
	declare series: ActivityPoint[] | null;
	declare attempt: AttemptTimeline | null;
	declare attemptView: boolean;
	declare pendingAction: string;
	declare draftPick: string | undefined;
	declare draftEffort: string | undefined;

	// Light DOM bridge: createRenderRoot returns this, so :host never
	// matches — the page's .kcard rules own the wrapper box (W2267.4.2.2:
	// the card inside needs a full-width block host to fill the column).
	static override styles = css``;

	constructor() {
		super();
		this.t = null;
		this.executors = [];
		this.executorPick = "";
		this.effortOptions = [];
		this.series = null;
		this.attempt = null;
		this.attemptView = false;
		this.pendingAction = "";
		this.draftPick = undefined;
		this.draftEffort = undefined;
	}

	// ── model derivation (validated shape in, card model out) ──

	/** Display model: top-requests group from spend attribution, falling
	 * back to the stamped model — the same derivation ownerLabel uses
	 * (tasks.ts), so card and table can never disagree. */
	private static modelOf(t: KanbanTask): string | undefined {
		const groups = t.spend?.model_groups;
		let top = "";
		let count = -1;
		if (groups)
			for (const [model, v] of Object.entries(groups)) {
				const requests =
					typeof v === "object" && v !== null
						? Number((v as { requests?: unknown }).requests ?? 0)
						: 0;
				if (Number.isFinite(requests) && requests > count) {
					top = model;
					count = requests;
				}
			}
		return top || t.model || undefined;
	}

	/** HOST column: lane owner display (label beats sid; both may be absent). */
	private static hostOf(t: KanbanTask): string | undefined {
		const label = t.owner_label?.trim();
		if (
			label &&
			label !== t.owner_sid &&
			!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label)
		)
			return label;
		return t.owner_sid ?? undefined;
	}

	/** Spend → the four metrics (unknown stays undefined → "—"). */
	private static metricsOf(t: KanbanTask): TaskMetrics | undefined {
		const sp = t.spend;
		if (!sp) return undefined;
		const fresh = sp.fresh ?? undefined;
		const cached = sp.cached ?? undefined;
		const out = sp.out ?? undefined;
		const wallMs = sp.wall_ms ?? undefined;
		const tokens =
			fresh === undefined && cached === undefined && out === undefined
				? undefined
				: (fresh ?? 0) + (cached ?? 0) + (out ?? 0);
		const mins = wallMs !== undefined && wallMs > 0 ? wallMs / 60000 : 0;
		const tokPerMin = mins > 0 && out !== undefined ? out / mins : undefined;
		const denom = (fresh ?? 0) + (cached ?? 0);
		const cachePct =
			denom > 0 && cached !== undefined ? (cached / denom) * 100 : undefined;
		return { tokens, wallMs, tokPerMin, cachePct };
	}

	/** Split/blocked parent reference (nested children only). */
	private static parentRefOf(t: KanbanTask): string | undefined {
		return t.parent_id ?? undefined;
	}

	/** Quiet context lines: execution proof AND wait/blocked/split reasons —
	 * #103191: each rides its OWN compact visible line (a single joined
	 * line truncated the split/wait context away). #103658: the bound
	 * lane's last-output tail is card information too — it renders as its
	 * own bounded line AFTER the structural context (deduped when a prior
	 * part already says the same thing), never suppressed by it. */
	private contextLinesOf(t: KanbanTask): string[] {
		const parts: string[] = [];
		const ex = t.execution;
		if (ex) {
			const stage = ex.progress?.stage;
			parts.push(
				stage
					? `${ex.state} · ${stage}`
					: `${ex.state} · no artifact evidence in snapshot`,
			);
		}
		if (t.state === "WAITING" && t.wait_reason)
			parts.push(`${t.wait_kind ?? "external"} · ${t.wait_reason}`);
		const blocked = t.blocked_by ?? [];
		if (blocked.length) parts.push(`waiting on ${blocked.join(", ")}`);
		const waiting = t.waiting_on ?? [];
		if (waiting.length) parts.push(`split into ${waiting.join(", ")}`);
		const tail = t.tail?.text?.trim();
		if (tail && !parts.includes(tail)) parts.push(tail);
		return parts;
	}

	/** One wire task → the card model; null when the payload did not
	 * parse — rendered as an honest invalid state, never laundered. */
	private modelOf(t: KanbanTask): TaskCardModel | null {
		const base: TaskCardModel = {
			id: t.id,
			project: t.project ?? undefined,
			title: t.title ?? undefined,
			state: t.state,
			ageS: t.age_s ?? undefined,
			contextLines: this.contextLinesOf(t),
			parentRef: KlhTaskCardHost.parentRefOf(t),
			model: KlhTaskCardHost.modelOf(t),
			host: KlhTaskCardHost.hostOf(t),
			warn: t.failure_note ?? undefined,
			metrics: KlhTaskCardHost.metricsOf(t),
			nested: this.hasAttribute("data-nested"),
			preferColor: t.tag_color ?? undefined,
			executors: this.executors,
			// Root #103404: a banked draft wins over the fresh default —
			// the new card's own fields are empty, so the pick re-hydrates
			// the select; once the user touches it again the card's own
			// draft overrides from there.
			executorPick: this.draftPick ?? this.executorPick,
			effortOptions: this.effortOptions,
			effortPick: this.draftEffort ?? "",
			pendingAction: this.pendingAction || undefined,
		};
		const r = TaskCardModelSchema.safeParse(base);
		return r.success ? r.data : null;
	}

	protected override render() {
		const parsed = KanbanTaskSchema.safeParse(this.t);
		if (!this.t || !parsed.success) {
			// honest state (fail-loud boundary): no card renders from an
			// unvalidated payload — the slot stays observable without
			// laundering an opaque object through the model.
			return html`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;
		}
		const t = parsed.data;
		const model = this.modelOf(t);
		if (!model) return html``;
		const strip =
			this.series || this.attempt
				? html`<klh-card-activity
						slot="activity"
						.points=${this.series ?? []}
						.wallMs=${KlhTaskCardHost.metricsOf(t)?.wallMs ?? null}
						.attempt=${this.attempt}
						.mode=${this.attemptView ? "attempt" : "spend"}
					></klh-card-activity>`
				: null;
		return html`<klh-task-card .card=${model}>${strip}</klh-task-card>`;
	}

	/** Light DOM: page CSS (.kcard layout law) keeps applying; the card's
	 * own styles are shadow-scoped inside <klh-task-card>. */
	protected override createRenderRoot(): HTMLElement {
		return this;
	}
}
