// hooks/board-html/klh-decisions.ts — the decisions tab as a light-DOM Lit
// feature (W2550.1; replaces the legacy DECISIONS/HISTORY string chunks).
// It renders OPEN decision cards, the gated-work list, and decision history
// into the page's light DOM — the section skeleton and CSS stay in the page
// (#decisions/#hist ids, .dec/.gated/.hrow classes keep every existing
// locator), so `createRenderRoot` returns the host. Properties in, events
// out: every side effect (answer/advise/cancel) rides a typed
// Decision*RequestedEvent for <klh-decisions-mediator> to perform; drafts,
// option picks, and focus survive re-renders via the mediator's request
// state and the input's own value (the render never replaces a focused
// input's value).
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { ago, msAgo } from "./board-format.ts";
import {
	DecisionAnswerRequestedEvent,
	DecisionAdviseRequestedEvent,
	DecisionCancelRequestedEvent,
} from "./decisions-events.ts";

/** W862: the validated hub-policy provenance payload. */
export type PolicyRef = {
	hub?: string;
	id?: number | string;
	sha256?: string;
};

/** One /api/decisions record (loose subset — the feed schema gates the wire). */
export type DecisionRow = {
	id: string;
	project?: string;
	question?: string;
	asked_by?: string;
	asked_by_label?: string;
	age_s?: number | null;
	created_ts?: number;
	task_id?: string;
	task_title?: string;
	task_state?: string;
	/** wire row's lifecycle state ('OPEN' on the live feed; HistoryRow rows
	 * carry the terminal value) — optional defense, never asserted */
	state?: string;
	options?: { label?: string; tradeoff?: string }[] | null;
	dup_of?: string | null;
	dup_count?: number;
	owner_actionable?: boolean;
	owner_reason?: string;
	delivery?: string;
	policy?: PolicyRef | null;
	answer_token?: string;
};

/** The needs-you advice record (dec row or the /api/data needs map). */
export type AdviceRow = DecisionRow & {
	advice?: {
		rec?: string;
		model?: string;
		rationale?: string;
		risk?: string;
		panel?: AdvicePanel | null;
	} | null;
	adviceError?: string | null;
	advicePending?: string | boolean | null;
};

/** A gated/blocked work row (payload .gated — the report's needs-you set). */
export type GatedRow = {
	id: string;
	title?: string;
	project?: string;
	reason?: string;
	best_action?: string;
	age_s?: number | null;
};

/** History row = a decision with state ≠ OPEN. */
export type HistoryRow = DecisionRow & {
	state?: string;
	answer_note?: string;
	answered_ts?: number;
	ack_ts?: number;
};

/** One oracle leg's verdict row (the panel stdout shape). */
export type AdviceLeg = {
	name?: string;
	model?: string;
	ok?: boolean;
	ms?: number;
	verdict?: string;
	error?: string;
};

/** W742.2 panel verdicts (the oracle panel stdout shape). */
export type AdvicePanel = {
	consensus?: string;
	legs?: AdviceLeg[];
};

/** Per-decision request state the mediator owns and hands back down. */
export type DecisionRequestState = {
	/** id → true while an answer POST is in flight */
	answering: Record<string, boolean>;
	/** id → inline answer/cancel error */
	ansErr: Record<string, string>;
	/** id → answer accepted (until the poll drops the card) */
	sentOk: Record<string, boolean>;
	/** id → typed-but-unsent draft */
	drafts: Record<string, string>;
	/** id → chosen option label (selecting, not submitting) */
	selOpt: Record<string, string>;
	/** id → ms when the advise request started */
	advising: Record<string, number>;
	/** id → {n, at} advise transport-failure backoff */
	advRetry: Record<string, { n: number; at: number }>;
	/** id → completed automatic retries */
	advAttempts: Record<string, number>;
	/** id → advise request error (inline, retry button) */
	advErr: Record<string, string>;
};

/** The feed-state slice the mediator pushes into the leaf. */
export type DecisionsSlice = {
	dec: {
		loaded: boolean;
		err: string | null;
		okAt: number;
		data: { decisions?: DecisionRow[]; gated?: GatedRow[] } | null;
	};
	hist: {
		loaded: boolean;
		err: string | null;
		okAt: number;
		data: { decisions?: HistoryRow[] } | null;
	};
	open: boolean;
	/** live board search + deep-link filter needles ('' = no filter) */
	query: string;
	filter: string;
	/** the project scope the feed payload is already scoped to */
	project: string;
	/** /api/data needs map flattened to id → advice row (W667 advice view) */
	needs: Record<string, AdviceRow>;
};

const agoOf = (s: number | null | undefined): string => ago(s ?? null);

/** recommendation text the "use" button accepts (a real sentence, not a
 * heading) — exported for the unit pins (the old chunk-scope contract) */
export const usableRec = (rec: unknown): boolean =>
	typeof rec === "string" &&
	rec.trim().length >= 8 &&
	!/^\s*(?:#{1,6}\s*|\*\*|analysis\s+of\b|recommendation\s+:)/i.test(rec);

/** W742.2 consensus class: split → psplit, consensus X → pagree */
export const panelClassOf = (consensus: unknown): string => {
	const c = String(consensus ?? "");
	if (c.startsWith("split")) return " psplit";
	if (c.startsWith("consensus ")) return " pagree";
	return "";
};

/** W862 policy provenance line — origin disclosed never inferred; the
 * backend validates the payload shape (policyProvenance). */
export const policySrcOf = (policy: PolicyRef): string =>
	`policy provenance: hub ${policy.hub} · row ${policy.id} · pin ${String(
		policy.sha256 ?? "",
	).slice(0, 12)}…`;

/** One panel leg's text line (lit-html renders it as text — escaping is
 * structural, the old esc() assembly retired with the chunk) */
export const legLine = (l: AdviceLeg): string =>
	`— ${l.name || "leg"} (${l.model || "?"}) ${l.ok ? `${l.ms}ms` : "FAILED"} — ${
		l.ok
			? l.verdict
				? String(l.verdict).toUpperCase()
				: "NO VERDICT"
			: "UNAVAILABLE"
	}`;

export class KlhDecisions extends LitElement {
	static override properties = {
		slice: { attribute: false },
		requests: { attribute: false },
		collapsed: { type: Boolean, reflect: true },
		histOpen: { type: Boolean, reflect: true },
	};

	declare slice: DecisionsSlice;
	declare requests: DecisionRequestState;
	declare collapsed: boolean;
	declare histOpen: boolean;

	constructor() {
		super();
		this.slice = {
			dec: { loaded: false, err: null, okAt: 0, data: null },
			hist: { loaded: false, err: null, okAt: 0, data: null },
			open: true,
			query: "",
			filter: "",
			project: "",
			needs: {},
		};
		this.requests = {
			answering: {},
			ansErr: {},
			sentOk: {},
			drafts: {},
			selOpt: {},
			advising: {},
			advRetry: {},
			advAttempts: {},
			advErr: {},
		};
		this.collapsed = false;
		this.histOpen = false;
	}

	/** Light DOM: the section skeleton and page CSS keep working. */
	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	/** W798: members render under the primary's "+N like this" badge. The
	 * project filter is client-side too (defense against an unscoped
	 * payload — the old chunk's decisionInProject contract). */
	private openDecs(): DecisionRow[] {
		const ds = this.slice.dec.data?.decisions ?? [];
		const out: DecisionRow[] = [];
		for (const d of ds) {
			if (d.dup_of) continue;
			if (d.state && d.state !== "OPEN") continue;
			if (!this.inProject(d)) continue;
			out.push(d);
		}
		return out;
	}

	private inProject(d: DecisionRow): boolean {
		const sel = this.slice.project;
		return !sel || sel === "all" || d.project === sel;
	}

	/** Search/query needle match (renamed from `matches` — that name is the
	 * DOM Element method and collides under strict DOM typing). */
	private rowMatches(
		row: { id?: string; question?: string; title?: string },
		extra: (string | undefined)[],
	): boolean {
		const parts = [row.id, row.question ?? row.title, ...extra];
		for (const needle of [this.slice.filter, this.slice.query]) {
			if (!needle) continue;
			const q = needle.toLowerCase();
			const hit = parts.some((p) =>
				String(p ?? "")
					.toLowerCase()
					.includes(q),
			);
			if (!hit) return false;
		}
		return true;
	}

	private decMatches(d: DecisionRow): boolean {
		return this.rowMatches(d, [d.asked_by, d.asked_by_label, d.project]);
	}

	private gatedMatches(g: GatedRow): boolean {
		return this.rowMatches(g, [g.project]);
	}

	private byId(id: string): DecisionRow | null {
		const ds = this.slice.dec.data?.decisions ?? [];
		for (const d of ds) if (d.id === id && this.inProject(d)) return d;
		return null;
	}

	/** W667: the advice record — the dec row when it carries advice, else the
	 * flattened /api/data needs map the mediator pushes down. */
	private adviceFor(id: string): AdviceRow | null {
		const d = this.byId(id);
		if (
			d &&
			(("advice" in d && (d as AdviceRow).advice) ||
				("adviceError" in d && (d as AdviceRow).adviceError))
		)
			return d as AdviceRow;
		return this.slice.needs[id] ?? null;
	}

	private pick(id: string, label: string): void {
		const d = this.byId(id);
		if (!d) return;
		for (const o of d.options ?? [])
			if (o.label === label) {
				this.requests.selOpt[id] = label;
				const inp = this.querySelector<HTMLInputElement>(
					`.dec[data-id="${id}"] input.ans`,
				);
				if (inp) {
					inp.value = label;
					this.requests.drafts[id] = label;
					inp.focus();
				}
				this.requestUpdate();
			}
	}

	private send(id: string): void {
		const inp = this.querySelector<HTMLInputElement>(
			`.dec[data-id="${id}"] input.ans`,
		);
		const note = (inp?.value ?? "").trim();
		if (!note) {
			this.requests.ansErr[id] = "type an answer first";
			this.requestUpdate();
			return;
		}
		this.dispatchEvent(new DecisionAnswerRequestedEvent(id, note));
	}

	private use(id: string): void {
		const a = this.adviceFor(id);
		const inp = this.querySelector<HTMLInputElement>(
			`.dec[data-id="${id}"] input.ans`,
		);
		if (!a?.advice || !inp || !usableRec(a.advice.rec)) return;
		inp.value = a.advice.rec ?? "";
		this.requests.drafts[id] = inp.value;
		inp.focus();
	}

	private toggleHist(): void {
		this.histOpen = !this.histOpen;
		this.dispatchEvent(
			new CustomEvent("hist-toggle", {
				detail: this.histOpen,
				bubbles: true,
				composed: true,
			}),
		);
	}

	protected override render() {
		const all = this.openDecs();
		const visible = all.filter((d) => this.decMatches(d));
		const cls = [this.collapsed ? "closed" : "", all.length > 0 ? "has" : ""]
			.filter(Boolean)
			.join(" ");
		return html`
			<section id="decisions" class=${cls || nothing}>
				<h2>
					<button
						id="decToggle"
						type="button"
						@click=${() => {
							this.dispatchEvent(
								new CustomEvent("collapse-toggle", {
									detail: !this.collapsed,
									bubbles: true,
									composed: true,
								}),
							);
						}}
					>
						<span id="decCaret">${this.collapsed ? "+" : "-"}</span> Decisions needed
					</button>
					<span id="decState" aria-live="polite">${this.stateText(all)}</span>
				</h2>
				<klh-err-banner
					id="decErr"
					feed="dec"
					.text=${this.feedErrText()}
				></klh-err-banner>
				<div id="decList">
					${visible.map((d) => this.renderDec(d))}
				</div>
				<h3 class="gatedhead">
					Gated work
					<span class="dim">
						owner-gated + blocked items — the report's needs-you rows
					</span>
				</h3>
				<div id="gatedList">${this.renderGated()}</div>
			</section>
			<div id="hist">
				<div class="histhead">
					<button
						id="histHead"
						type="button"
						aria-expanded=${this.histOpen ? "true" : "false"}
						@click=${this.toggleHist}
					>
						<span id="histCaret">${this.histOpen ? "-" : "+"}</span> History
					</button>
					<span id="histState">${this.histStateText()}</span>
				</div>
				<klh-err-banner
					id="histErr"
					feed="hist"
					.text=${this.histFeedErrText()}
				></klh-err-banner>
				<div
					id="histBody"
					style=${this.histOpen ? "display:block" : "display:none"}
				>
					${this.renderHist()}
				</div>
			</div>
		`;
	}

	/** The banner carries the feed error (with its retry button); decState
	 * mirrors the old contract: empty line while the banner shows the fault. */
	private feedErrText(): string {
		const s = this.slice.dec;
		if (!s.loaded || !s.err) return "";
		return `decision feed unavailable — last good ${
			s.okAt ? agoOf(Math.round((Date.now() - s.okAt) / 1000)) : "never"
		}`;
	}

	private histFeedErrText(): string {
		if (!this.histOpen) return "";
		const s = this.slice.hist;
		if (!s.err) return "";
		const when = s.okAt
			? agoOf(Math.round((Date.now() - s.okAt) / 1000))
			: "never";
		return `history unavailable — last good ${when}`;
	}

	private stateText(all: DecisionRow[]): string {
		const s = this.slice.dec;
		if (!s.loaded) return "loading decisions...";
		if (s.err) return "";
		if (all.length)
			return this.slice.query || this.slice.filter
				? `${all.filter((d) => this.decMatches(d)).length} of ${all.length} decisions shown`
				: `${all.length} decision${all.length === 1 ? "" : "s"} need you`;
		return `No pending decisions · checked ${agoOf(Math.round((Date.now() - s.okAt) / 1000))}`;
	}

	private renderDec(d: DecisionRow): TemplateResult {
		const id = d.id;
		const rq = this.requests;
		const errText =
			rq.ansErr[id] ||
			(d.owner_reason === "target-dead"
				? "The target lane is absent. Review the linked work and question; record an owner ruling or dismiss if obsolete."
				: d.delivery === "FAILED"
					? "delivery failed — press Send to retry"
					: "");
		const ruling = Boolean(d.owner_actionable);
		const dup = (d.dup_count ?? 0) > 1;
		return html`<div
			class="dec${rq.sentOk[id] ? " sent" : ""}"
			data-id=${id}
		>
			<div class="dbody">
			<div class="dhead">
				<span class="dproj mono">${d.project || "(unknown project)"}</span>
				<span class="dwho"
					>${d.asked_by_label || d.asked_by || "?"} · #${id}</span
				>
				${
					d.owner_actionable
						? html`<span class="dstale pill block"
							>${
								d.owner_reason === "target-dead"
									? "target lane absent"
									: "owner ruling"
							}</span
						>`
						: nothing
				}
				${
					dup
						? html`<span class="ddup pill"
							>+${(d.dup_count ?? 1) - 1} like this</span
						>`
						: nothing
				}
				${
					d.policy ? html`<span class="dpol pill block">policy</span>` : nothing
				}
				<span class="dage dim">${this.decAge(d)}</span>
			</div>
			<div class="dq">${d.question || "(no question text)"}</div>
			<div class="dblocks">${this.blocksText(d)}</div>
			${
				d.policy
					? html`<div class="dsrc dim">${policySrcOf(d.policy)}</div>`
					: nothing
			}
			<div class="dopts">
				${(d.options ?? []).map(
					(o) => html`<div
						class="optrow${rq.selOpt[id] === o.label ? " sel" : ""}"
					>
						<button
							type="button"
							class="opt"
							aria-pressed=${rq.selOpt[id] === o.label ? "true" : "false"}
							@click=${() => o.label && this.pick(id, o.label)}
						>
							${o.label}
						</button>
						<span class="trade dim">${o.tradeoff || ""}</span>
					</div>`,
				)}
			</div>
			${this.renderAdvice(id)}
			<div class="dans">
				<input
					class="ans"
					placeholder="your decision..."
					.value=${rq.drafts[id] ?? ""}
					@input=${(e: InputEvent) => {
						this.requests.drafts[id] = (e.target as HTMLInputElement).value;
					}}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter") {
							e.preventDefault();
							this.send(id);
						}
					}}
				/>
			</div>
			<div class="derr" role="alert">${errText}</div>
			</div>
			<div class="drail" role="group" aria-label="decision actions">
				<button
					class="send"
					type="button"
					?disabled=${rq.answering[id] || false}
					@click=${() => this.send(id)}
				>
					${rq.sentOk[id] ? "Sent" : ruling ? "Record ruling" : "Send"}
				</button>
				<button
					class="getrec"
					type="button"
					?disabled=${rq.advising[id] !== undefined || false}
					@click=${() =>
						this.dispatchEvent(new DecisionAdviseRequestedEvent(id))}
				>
					Get recommendation
				</button>
				<button
					class="dismiss"
					type="button"
					@click=${() =>
						this.dispatchEvent(new DecisionCancelRequestedEvent(id))}
				>
					${d.owner_reason === "target-dead" ? "Dismiss if obsolete" : "Cancel"}
				</button>
			</div>
		</div>`;
	}

	private decAge(d: DecisionRow): string {
		if (d.age_s != null) return agoOf(d.age_s);
		if (d.created_ts)
			return agoOf(Math.max(0, Math.round((Date.now() - d.created_ts) / 1000)));
		return "";
	}

	private blocksText(d: DecisionRow): string {
		return d.task_id
			? `linked work: ${d.task_id} · ${d.task_title || "(untitled)"}${
					d.task_state
						? ` · ${d.task_state.toLowerCase()}`
						: " · missing from work graph"
				}`
			: "linked work: none";
	}

	private renderAdvice(id: string): TemplateResult | typeof nothing {
		const rq = this.requests;
		const advice = this.adviceFor(id);
		if (rq.advising[id] !== undefined) {
			const secs = Math.round((Date.now() - (rq.advising[id] ?? 0)) / 1000);
			return html`<div class="dadv">
				<span class="dim"
					>${
						advice?.advicePending === "queued"
							? "recommendation queued"
							: `getting recommendation... ${secs}s`
					}${rq.advRetry[id] ? " (retrying)" : ""}</span
				>
			</div>`;
		}
		if (rq.advErr[id])
			return html`<div class="dadv">
				<span class="risk">advice request failed: ${rq.advErr[id]}</span>
				<button
					class="advretry"
					type="button"
					@click=${() =>
						this.dispatchEvent(new DecisionAdviseRequestedEvent(id))}
				>
					retry
				</button>
			</div>`;
		if (advice?.adviceError)
			return html`<div class="dadv">
				<span class="risk">advice failed: ${advice.adviceError}</span>
				<button
					class="advretry"
					type="button"
					@click=${() =>
						this.dispatchEvent(new DecisionAdviseRequestedEvent(id))}
				>
					retry
				</button>
			</div>`;
		const ac = advice?.advice;
		if (!ac) return nothing;
		return html`<div class="dadv">
			<div class="rhead">
				RECOMMENDATION${
					ac.model ? html` <span class="dim">${ac.model}</span>` : nothing
				}
			</div>
			<div class="rec">${ac.rec || ""}</div>
			${ac.rationale ? html`<div class="why">${ac.rationale}</div>` : nothing}
			${ac.risk ? html`<div class="risk">risk: ${ac.risk}</div>` : nothing}
			${ac.panel ? this.renderPanel(ac.panel) : nothing}
			${
				usableRec(ac.rec)
					? html`<button class="use" type="button" @click=${() => this.use(id)}>
						use
					</button>`
					: html`<span class="risk">No usable recommendation — retry</span>
						<button
							class="advretry"
							type="button"
							@click=${() =>
								this.dispatchEvent(new DecisionAdviseRequestedEvent(id))}
						>
							retry
						</button>`
			}
		</div>`;
	}

	private renderPanel(p: AdvicePanel): TemplateResult {
		const c = String(p.consensus ?? "");
		return html`<div>
			<div class="pconsensus${panelClassOf(c)}">${c}</div>
			${(p.legs ?? []).map(
				(l) => html`<div class="pleg">${legLine(l)}</div>
					${
						!l.ok && l.error
							? html`<div class="plegerr dim">${l.error}</div>`
							: nothing
					}`,
			)}
		</div>`;
	}

	private renderGated(): (TemplateResult | typeof nothing)[] {
		const gs = this.slice.dec.data?.gated ?? [];
		return gs.map((g) =>
			this.gatedMatches(g)
				? html`<div class="gated" data-id=${g.id}>
						<div class="dhead">
							<span class="dproj mono">${g.project || "(unknown project)"}</span>
							<span class="dwho"
								>${g.id} · ${g.reason === "gated" ? "owner-gated" : "blocked"}</span
							>
							<span class="dage dim">${agoOf(g.age_s)}</span>
						</div>
						<div class="dq">${g.title || "(untitled)"}</div>
						<div class="dadv rec">${g.best_action || ""}</div>
					</div>`
				: nothing,
		);
	}

	private histStateText(): string {
		if (!this.histOpen) return "";
		const s = this.slice.hist;
		const rows = this.histRows();
		if (!s.loaded && !s.err) return "loading history...";
		if (s.err)
			return rows.length ? `${rows.length} archived · stale` : "unavailable";
		return rows.length ? `${rows.length} archived` : "(no archived decisions)";
	}

	private histRows(): HistoryRow[] {
		const ds = this.slice.hist.data?.decisions ?? [];
		// the feed URL is project-scoped; the client filter is the second half
		// of the old decisionInProject contract (foreign rows never render)
		return ds.filter((d) => d.state && d.state !== "OPEN" && this.inProject(d));
	}

	private renderHist(): (TemplateResult | typeof nothing)[] {
		if (!this.histOpen) return [];
		const rows = this.histRows();
		if (!rows.length) return [];
		return rows.map(
			(d) => html`<div class="hrow">
				<span class="pill hst">${String(d.state).toLowerCase()}</span>
				<span>
					<span class="hq"
						>${String(d.question || "(no question text)").slice(0, 140)}</span
					>
					${
						d.answer_note
							? html`<span class="hans"
								>${String(d.answer_note).slice(0, 200)}</span
							>`
							: nothing
					}
				</span>
				<span class="hage dim"
					>${agoOf(msAgo(d.answered_ts || d.ack_ts || d.created_ts))}</span
				>
			</div>`,
		);
	}

	static override styles = css`
		:host {
			display: block;
		}
	`;
}

if (!customElements.get("klh-decisions"))
	customElements.define("klh-decisions", KlhDecisions);

declare global {
	interface HTMLElementTagNameMap {
		"klh-decisions": KlhDecisions;
	}
}
