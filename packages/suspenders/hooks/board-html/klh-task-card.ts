// hooks/board-html/klh-task-card.ts — the approved SIGNAL-layout task card
// as a stateless Lit leaf (W2267.4.1). Data down: one `card` property (the
// zod-derived TaskCardModel). Events up: TaskCardOpenRequestedEvent (ID
// button) and TaskCardActionRequestedEvent (footer rail) — the card never
// fetches, never POSTs, never writes state on render/poll. Layout per the
// 09 spec: status square+word and age once upper; own-line mono ID; heavy
// sans title; quiet context; ruled MODEL|HOST columns; warning band before
// the four metrics; the `activity` slot hosts the sibling strip component
// flush at the bottom (W2267.2's <klh-card-activity> — spend/attempt ride
// the SAME slot, mode/data contract in klh-task-card-model.ts). The
// configurable perimeter (--prefer) is independent of the status hue;
// nested split children get the dashed border + elbow. Light-DOM friendly:
// tokens only, no hardcoded colors.
import { LitElement, css, html, nothing } from "lit";
import { ago, agoShort } from "./board-format.ts";
import {
	TaskCardActionRequestedEvent,
	TaskCardOpenRequestedEvent,
} from "./klh-task-card-events.ts";
import {
	type TaskCardActionKind,
	type TaskCardModel,
	fmtPct,
	fmtRate,
	fmtTokens,
	fmtWall,
	taskTone,
} from "./klh-task-card-model.ts";

const UNK = "—";

export class KlhTaskCard extends LitElement {
	static properties = { card: { attribute: false } };

	declare card: TaskCardModel;

	static styles = css`
		/* tone → color, self-contained: the page maps data-tone on .kcard/
		   .kcol only, so the card owns its own --state-color token map. */
		:host([data-tone="ready"]) { --state-color: var(--work-ready); }
		:host([data-tone="working"]) { --state-color: var(--work-working); }
		:host([data-tone="blocked"]) { --state-color: var(--work-blocked); }
		:host([data-tone="failed"]) { --state-color: var(--work-failed); }
		:host([data-tone="done"]) { --state-color: var(--work-done); }
		:host([data-tone="split"]) { --state-color: var(--work-split); }
		:host([data-tone="cancelled"]) { --state-color: var(--work-cancelled); }
		:host {
			/* the host IS the card surface: configurable semantic perimeter
			   (—prefer) independent of --state-color; nested children dashed. */
			display: flex;
			flex-direction: column;
			border: 1px solid
				var(--prefer, var(--state-color, var(--klh-edge-soft)));
			border-radius: 3px;
			background: var(--klh-wash);
			font: var(--klh-text-md, var(--klh-typo-size-m, 12px))/1.45
				var(--klh-font-sans, var(--klh-typo-sans-stack));
			color: var(--klh-ink);
			min-width: 0;
		}
		:host([data-nested]) {
			border-style: dashed;
		}
		:host([data-nested]) .elbow {
			position: absolute;
			left: -13px;
			top: 13px;
			color: var(--prefer, var(--klh-edge-strong));
			font: 11px var(--klh-font-mono);
		}
		.wrap {
			position: relative;
			display: flex;
			flex-direction: column;
			min-height: 100%;
			padding: 9px 0 0;
		}
		.pad {
			padding: 0 12px;
		}
		.head {
			display: flex;
			align-items: baseline;
			gap: 6px;
			font-size: var(--klh-text-xs, var(--klh-typo-size-2xs, 10px));
			letter-spacing: var(--klh-typo-track-label, 0.09em);
			text-transform: uppercase;
			color: var(--state-color, var(--klh-dim));
		}
		.sq {
			flex: none;
			width: 7px;
			height: 7px;
			border-radius: 1px;
			background: var(--state-color, var(--klh-dim));
			align-self: center;
		}
		.stw {
			font-weight: 600;
		}
		.age {
			margin-left: auto;
			color: var(--klh-dim);
			text-transform: none;
			letter-spacing: 0;
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
		}
		.tid {
			margin: 4px 0 0;
			padding: 0;
			border: 0;
			background: none;
			color: var(--klh-ink);
			font: 600 var(--klh-typo-size-3xl, 18px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
			text-align: left;
			cursor: pointer;
			overflow-wrap: anywhere;
		}
		.tid:hover {
			text-decoration: underline;
		}
		.title {
			margin: 2px 0 0;
			font-weight: 650;
			font-size: var(--klh-typo-size-2xl, 16px);
			line-height: 1.35;
			/* long text truncates visually, full text stays accessible on hover */
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 3;
			overflow: hidden;
		}
		.ctx {
			margin: 3px 0 0;
			color: var(--klh-dim);
			font: var(--klh-typo-size-m, 12px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.rule {
			border: 0;
			border-top: 1px solid var(--klh-edge-faint);
			margin: 7px 0 0;
		}
		.cols {
			display: flex;
			gap: 0;
			margin-top: 5px;
			font: var(--klh-typo-size-s, 11px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
		}
		.col {
			flex: 1 1 0;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			padding: 0 10px;
		}
		.col:first-child {
			padding-left: 0;
		}
		.col:last-child {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.col b {
			font-weight: 600;
			color: var(--klh-ink-2);
		}
		.lab {
			display: block;
			margin-top: 2px;
			font-size: 8.5px;
			letter-spacing: 0.07em;
			text-transform: uppercase;
			color: var(--klh-dim);
		}
		.warn {
			margin: 7px 0 0;
			border-left: 2px solid var(--work-failed, var(--klh-danger));
			background: var(--klh-danger-wash);
			padding: 4px 8px;
			font-size: 10.5px;
			color: var(--klh-danger-ink);
		}
		.warn .wl {
			font-weight: 700;
			text-transform: uppercase;
			font-size: 9px;
			letter-spacing: 0.06em;
			margin-right: 5px;
		}
		.warn .wt {
			display: block;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.metrics {
			display: flex;
			margin-top: 8px;
		}
		.m {
			flex: 1 1 0;
			min-width: 0;
			padding: 0 10px;
			text-align: right;
		}
		.m:first-child {
			padding-left: 0;
			text-align: left;
		}
		.m + .m {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.mv {
			font: 600 var(--klh-typo-size-2xl, 16px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink);
		}
		.ml {
			display: block;
			margin-top: 1px;
			font-size: 8.5px;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--klh-dim);
			white-space: nowrap;
		}
		.details {
			display: block;
			margin-top: 6px;
			font-size: 10.5px;
			color: var(--klh-dim);
		}
		/* the activity slot sits flush at the card bottom: the strip's own
		   1px duration rail + ~13px axis area ride the slot, no extra padding. */
		.activity {
			display: block;
			margin-top: 8px;
			padding: 0;
		}
		footer {
			/* neutral segmented rail, full-width flush bottom */
			display: flex;
			align-items: stretch;
			width: 100%;
			margin: 8px 0 0;
			border-top: 1px solid var(--klh-edge-faint);
			background: var(--klh-surface);
			border-radius: 0 0 2px 2px;
		}
		footer:empty {
			display: none;
		}
		.spacer {
			/* the lone Prompt/Report sits rightmost; the rail's empty left
			   half stays bare surface with the segment dividers at the right */
			flex: 1 1 auto;
		}
		.seg {
			flex: 1 1 0;
			min-height: 32px;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 5px;
			padding: 4px 8px;
			border: 0;
			background: none;
			color: var(--klh-ink-2);
			font: 11px var(--klh-font-sans);
			cursor: pointer;
			white-space: nowrap;
		}
		.seg + .seg {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.seg:hover {
			background: var(--klh-surface-hi);
			color: var(--klh-ink);
		}
		.seg.retry {
			color: var(--klh-danger-ink);
		}
		.seg.recover {
			font-weight: 600;
		}
		.seg.prompt {
			color: var(--klh-accent);
		}
		.seg select {
			flex: 1 1 0;
			min-width: 0;
			height: 32px;
			background: var(--klh-field);
			color: var(--klh-ink);
			border: 1px solid var(--klh-edge-mid);
			border-radius: 2px;
			font: 10.5px var(--klh-font-mono);
			padding: 0 4px;
		}
		footer button.seg:focus-visible,
		.tid:focus-visible,
		.seg select:focus-visible {
			outline: 2px solid var(--klh-accent);
			outline-offset: -2px;
		}
	`;

	constructor() {
		super();
		this.card = { id: "", state: "READY" };
	}

	/** Tone → the page's --state-color vocabulary; the host reflects it so
	 * the perimeter fallback can use it while --prefer still wins. */
	private tone(): string {
		return taskTone(this.card.state);
	}

	private open(): void {
		this.dispatchEvent(
			new TaskCardOpenRequestedEvent(this.card.id, this.card.project ?? null),
		);
	}

	private act(
		action: TaskCardActionKind,
		pick?: { executor?: string; effort?: string },
	): void {
		this.dispatchEvent(
			new TaskCardActionRequestedEvent(
				action,
				this.card.id,
				this.card.project ?? null,
				pick,
			),
		);
	}

	private statusWord(): string {
		return this.card.state.toLowerCase();
	}

	protected render() {
		const c = this.card;
		const tone = this.tone();
		const m = c.metrics ?? null;
		const age = c.ageS == null ? UNK : agoShort(c.ageS);
		const ageFull = c.ageS == null ? "age unknown" : `open ${ago(c.ageS)}`;
		const executors = c.executors ?? [];
		const pick = c.executorPick ?? "";
		const effortOptions = c.effortOptions ?? [];
		const effortPick = c.effortPick ?? "";
		return html`
			${c.nested
				? html`<span class="elbow" aria-hidden="true">↳</span>`
				: nothing}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${tone}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${ageFull}>${age}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${c.id}
				</button>
				${c.title
					? html`<div class="title" title=${c.title}>${c.title}</div>`
					: nothing}
				${c.context
					? html`<div class="ctx" title=${c.context}>${c.context}</div>`
					: nothing}
				${c.parentRef
					? html`<div class="ctx" title=${`split under ${c.parentRef}`}
							>↳ ${c.parentRef}</div
						>`
					: nothing}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${c.model ?? ""}>${c.model ?? UNK}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${c.host ?? ""}>${c.host ?? UNK}</b>
					</div>
				</div>
				${c.warn
					? html`<div class="warn" role="note">
							<span class="wl">${tone === "failed" ? "blocked" : "warning"}</span>
							<span class="wt" title=${c.warn}>${c.warn}</span>
						</div>`
					: nothing}
				<div class="metrics">
					<div class="m">
						<span class="mv">${fmtTokens(m?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${fmtWall(m?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${fmtRate(m?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${fmtPct(m?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details pad" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${tone === "failed"
					? html`<button
							class="seg retry"
							type="button"
							@click=${() => this.act("retry")}
						>
							Retry
						</button>
						<button
							class="seg recover"
							type="button"
							@click=${() => this.act("recover")}
						>
							Recover → Ready
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${() => this.act("prompt")}
						>
							Prompt ↗
						</button>`
					: nothing}
				${tone === "ready" && executors.length
					? html`<select
							class="seg"
							aria-label=${`executor for ${c.id}`}
							@change=${(e: Event) => {
								/* draft only — Start executes (#100441) */
								this.draftExecutor = (e.target as HTMLSelectElement).value;
							}}
						>
							${executors.map(
								(o) => html`<option
									value=${o.value}
									?selected=${o.value === (this.draftExecutor ?? pick)}
								>
									${o.badge ?? ""}${o.label}
								</option>`,
							)}
						</select>
						${effortOptions.length
							? html`<select
									class="seg"
									aria-label=${`reasoning effort for ${c.id}`}
									@change=${(e: Event) => {
										this.draftEffort = (e.target as HTMLSelectElement).value;
									}}
								>
									${effortOptions.map(
										(o) => html`<option
											value=${o}
											?selected=${o === (this.draftEffort ?? effortPick)}
										>
											${o}
										</option>`,
									)}
								</select>`
							: nothing}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							@click=${() =>
								this.act("start", {
									executor: this.draftExecutor ?? pick,
									effort: this.draftEffort ?? effortPick,
								})}
						>
							Start ▶
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`
					: nothing}
				${tone === "working" && executors.length
					? html`<select
							class="seg"
							aria-label=${`reassign executor for ${c.id}`}
							@change=${(e: Event) => {
								/* draft only — Reassign executes (#100476) */
								this.draftExecutor = (e.target as HTMLSelectElement).value;
							}}
						>
							${executors.map(
								(o) => html`<option
									value=${o.value}
									?selected=${o.value === (this.draftExecutor ?? pick)}
								>
									${o.badge ?? ""}${o.label}
								</option>`,
							)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							@click=${() =>
								this.act("reassign", {
									executor: this.executorValue(),
								})}
						>
							Reassign ↻
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							@click=${() => this.act("release")}
						>
							Release ⏏
						</button>`
					: nothing}
				${tone !== "failed" && tone !== "ready" && tone !== "working"
					? html`<button
							class="seg prompt"
							type="button"
							@click=${() => this.act("prompt")}
						>
							Prompt ↗
						</button>`
					: nothing}
			</footer>
		`;
	}

	private executorValue(): string | undefined {
		const el = this.renderRoot.querySelector<HTMLSelectElement>(
			"select[aria-label^='executor'], select[aria-label^='reassign']",
		);
		return el?.value ?? undefined;
	}

	protected willUpdate(): void {
		// status square + perimeter stay independent: tone rides the host
		// attribute (page CSS maps data-tone → --state-color), --prefer is
		// set by the owner and never touched here.
		this.dataset.nested = this.card.nested ? "" : undefined;
		this.setAttribute("data-tone", this.tone());
		if (this.card.preferColor) this.style.setProperty("--prefer", this.card.preferColor);
		else this.style.removeProperty("--prefer");
	}
}

if (!customElements.get("klh-task-card"))
	customElements.define("klh-task-card", KlhTaskCard);

declare global {
	interface HTMLElementTagNameMap {
		"klh-task-card": KlhTaskCard;
	}
}
