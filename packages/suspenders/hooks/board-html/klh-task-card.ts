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
import { html, LitElement, nothing } from "lit";
import { ago, agoShort } from "./board-format.ts";
import { TASK_CARD_STYLES } from "./klh-task-card-css.ts";
import {
	TaskCardActionRequestedEvent,
	TaskCardDraftChangedEvent,
	TaskCardOpenRequestedEvent,
} from "./klh-task-card-events.ts";
import {
	fmtPct,
	fmtRate,
	fmtTokens,
	fmtWall,
	type TaskCardActionKind,
	type TaskCardModel,
	taskStatusWord,
	taskTone,
	taskWarnBody,
	taskWarnLabel,
} from "./klh-task-card-model.ts";

const UNK = "—";

export class KlhTaskCard extends LitElement {
	static override properties = { card: { attribute: false } };

	declare card: TaskCardModel;

	static override styles = TASK_CARD_STYLES;

	constructor() {
		super();
		this.card = { id: "", state: "READY" };
	}

	/** Draft selections survive polls (#100476): they live on the element,
	 * not the card model, and reset only when the card id itself changes. */
	private draftId: string | undefined;
	private draftExecutor: string | undefined;
	private draftEffort: string | undefined;

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

	/** Root #103404: an unsubmitted pick is news too — the mediator banks it
	 * in its rebuild-proof map, so a structural render that recreates this
	 * card (an unrelated card changed column) re-hydrates the draft. */
	private draft(d: { executor?: string; effort?: string }): void {
		this.dispatchEvent(
			new TaskCardDraftChangedEvent(this.card.id, this.card.project ?? null, d),
		);
	}

	private statusWord(): string {
		return taskStatusWord(this.card.state);
	}

	protected override render() {
		const c = this.card;
		const tone = this.tone();
		const m = c.metrics ?? null;
		const age = c.ageS == null ? UNK : agoShort(c.ageS);
		const ageFull = c.ageS == null ? "age unknown" : `open ${ago(c.ageS)}`;
		const executors = c.executors ?? [];
		const pick = c.executorPick ?? "";
		const effortOptions = c.effortOptions ?? [];
		const effortPick = c.effortPick ?? "";
		// #103127: the verb in flight renders busy + disabled (data-down
		// pendingAction from the mediator; the leaf never self-serves)
		const pending = c.pendingAction ?? "";
		const busy = (verb: string, label: string): string =>
			pending === verb ? `${label}…` : label;
		const off = (verb: string): boolean => pending === verb;
		const ariaBusy = (verb: string): "true" | "false" =>
			pending === verb ? "true" : "false";
		return html`
			${
				c.nested
					? html`<span class="elbow" aria-hidden="true">↳</span>`
					: nothing
			}
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
				${
					c.title
						? html`<div class="title" title=${c.title}>${c.title}</div>`
						: nothing
				}
				${(c.contextLines ?? []).map(
					(line) => html`<div class="ctx" title=${line}>${line}</div>`,
				)}
				${
					c.parentRef
						? html`<div class="ctx" title=${`parent ${c.parentRef}`}
							>↳ ${c.parentRef}</div
						>`
						: nothing
				}
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
				<hr class="rule" />
				${
					c.warn
						? html`<div class="warn" role="note">
							<span class="wl">${taskWarnLabel(c.warn)}</span>
							<span class="wt" title=${c.warn}>${taskWarnBody(c.warn)}</span>
						</div>`
						: nothing
				}
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
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${
					tone === "failed"
						? html`<button
							class="seg retry"
							type="button"
							?disabled=${off("retry")}
							aria-busy=${ariaBusy("retry")}
							@click=${() => this.act("retry")}
						>
							${busy("retry", "Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${off("recover")}
							aria-busy=${ariaBusy("recover")}
							@click=${() => this.act("recover")}
						>
							${busy("recover", "Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${() => this.act("prompt")}
						>
							Prompt ↗
						</button>`
						: nothing
				}
				${
					tone === "ready" && executors.length
						? html`<select
							class="seg"
							aria-label=${`executor for ${c.id}`}
							@change=${(e: Event) => {
								/* draft only — Start executes (#100441) */
								this.draftExecutor = (e.target as HTMLSelectElement).value;
								this.draft({ executor: this.draftExecutor });
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
						${
							effortOptions.length
								? html`<select
									class="seg"
									aria-label=${`reasoning effort for ${c.id}`}
									@change=${(e: Event) => {
										this.draftEffort = (e.target as HTMLSelectElement).value;
										this.draft({ effort: this.draftEffort });
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
								: nothing
						}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${off("start")}
							aria-busy=${ariaBusy("start")}
							@click=${() =>
								this.act("start", {
									executor: this.draftExecutor ?? pick,
									effort: this.draftEffort ?? effortPick,
								})}
						>
							${busy("start", "Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`
						: nothing
				}
				${
					tone === "ready" && !executors.length
						? // #101156: no executor catalog → Prompt stays, no Start row
							html`<span class="spacer"></span>${this.promptSeg()}`
						: nothing
				}
				${
					tone === "working" && !executors.length
						? // #101156: Release is independent of the executor catalog
							html`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${off("release")}
								aria-busy=${ariaBusy("release")}
								@click=${() => this.act("release")}
							>
								${busy("release", "Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`
						: nothing
				}
				${
					tone === "working" && executors.length
						? html`<select
							class="seg"
							aria-label=${`reassign executor for ${c.id}`}
							@change=${(e: Event) => {
								/* draft only — Reassign executes (#100476) */
								this.draftExecutor = (e.target as HTMLSelectElement).value;
								this.draft({ executor: this.draftExecutor });
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
							?disabled=${off("reassign")}
							aria-busy=${ariaBusy("reassign")}
							@click=${() =>
								this.act("reassign", {
									executor: this.draftExecutor ?? pick,
								})}
						>
							${busy("reassign", "Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${off("release")}
							aria-busy=${ariaBusy("release")}
							@click=${() => this.act("release")}
						>
							${busy("release", "Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`
						: nothing
				}
				${
					tone === "done"
						? html`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${() => this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`
						: nothing
				}
				${
					tone !== "failed" &&
					tone !== "ready" &&
					tone !== "working" &&
					tone !== "done"
						? html`<span class="spacer"></span>${this.promptSeg()}`
						: nothing
				}
			</footer>
		`;
	}

	/** The rightmost bounded Prompt segment every non-terminal state keeps
	 * (#100476): actions preserved for every state, empty rail to its left. */
	private promptSeg() {
		return html`<button
			class="seg tail prompt"
			type="button"
			@click=${() => this.act("prompt")}
		>
			Prompt ↗
		</button>`;
	}

	protected override willUpdate(): void {
		// status square + perimeter stay independent: tone rides the host
		// attribute (page CSS maps data-tone → --state-color), --prefer is
		// set by the owner and never touched here.
		this.toggleAttribute("data-nested", !!this.card.nested);
		if (this.draftId !== this.card.id) {
			// drafts are per-item: a poll that swaps the whole card model must
			// not leak the previous item's executor/effort pick into this one
			this.draftId = this.card.id;
			this.draftExecutor = undefined;
			this.draftEffort = undefined;
		}
		this.setAttribute("data-tone", this.tone());
		if (this.card.preferColor)
			this.style.setProperty("--prefer", this.card.preferColor);
		else this.style.removeProperty("--prefer");
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"klh-task-card": KlhTaskCard;
	}
}
