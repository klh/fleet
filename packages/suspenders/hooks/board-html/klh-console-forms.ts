// hooks/board-html/klh-console-forms.ts — W695.3.2: the console settings
// form widgets as Lit shadow-DOM components (UI law). Replaces the inline
// EXECUTOR_EDITOR_JS string script + server-built diff markup in
// console-html.ts. Both widgets keep a LIGHT-DOM fallback/carrier so the
// native form round-trip survives: <klh-executor-editor> owns a light
// <input type=hidden name=default_executors> the form posts; <klh-diff-view>
// carries the server-rendered <pre class=diff> as its no-JS fallback (shadow
// DOM hides it once the component upgrades). Built by `bun run build:vendor`
// to vendor/klh-console-forms.js — offline, never CDN.
import { LitElement, css, html, type TemplateResult } from "lit";
import { cardCss } from "./klh-console-card-css.ts";

export interface ExecutorOption {
	value: string;
	label: string;
	group?: string;
}

const FORM_CSS = css`
	.hint {
		font-size: 10.5px;
		color: var(--klh-dim);
		margin: 2px 0 8px;
	}
	ol {
		list-style: none;
		counter-reset: ex;
		margin: 8px 0;
		padding: 0;
		max-width: 640px;
	}
	li {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 4px 0;
		border-bottom: 1px solid var(--klh-rule);
	}
	li::before {
		counter-increment: ex;
		content: counter(ex) ". ";
		font-size: 11px;
		color: var(--klh-dim);
		min-width: 22px;
	}
	.exv {
		flex: 1;
		font: 12px var(--klh-font-mono);
		word-break: break-all;
	}
	.add {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		margin-top: 8px;
		max-width: 640px;
	}
	.add div {
		flex: 1;
	}
	label {
		display: block;
		font-size: 10px;
		color: var(--klh-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin: 8px 0 3px;
	}
	select {
		width: 100%;
		background: var(--klh-bg);
		color: var(--klh-ink);
		border: 1px solid var(--klh-edge);
		border-radius: 2px;
		padding: 5px 8px;
		font: 12px var(--klh-font-mono);
	}
	button {
		background: var(--klh-bg);
		color: var(--klh-ink);
		border: 1px solid var(--klh-edge-strong);
		border-radius: 2px;
		padding: 5px 12px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
`;

// ─── <klh-executor-editor> — ordered executor-preference chain ────────────
// The light-DOM hidden input is the single source of truth (comma-joined —
// the exact shape formToBoardSettings parses); shadow rows render from it
// and every edit writes it back.
class KlhExecutorEditor extends LitElement {
	static properties = {
		heading: { type: String },
		options: { type: Array },
		chain: { state: true },
		pick: { state: true },
	};
	static styles = [cardCss, FORM_CSS];

	declare heading: string;
	declare options: ExecutorOption[];
	declare chain: string[];
	declare pick: string;

	constructor() {
		super();
		this.heading = "executor preference order";
		this.options = [];
		this.chain = [];
		this.pick = "";
	}

	private get carrier(): HTMLInputElement | null {
		return this.querySelector('input[name="default_executors"]');
	}

	connectedCallback(): void {
		super.connectedCallback();
		const v = this.carrier?.value ?? "";
		this.chain = v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	private set(next: string[]): void {
		this.chain = next;
		const c = this.carrier;
		if (c) c.value = next.join(",");
	}

	private move(i: number, d: number): void {
		const j = i + d;
		if (j < 0 || j >= this.chain.length) return;
		const next = [...this.chain];
		[next[i], next[j]] = [next[j], next[i]];
		this.set(next);
	}

	private add(): void {
		const sel = this.renderRoot.querySelector("select");
		const v = sel?.value ?? this.pick;
		if (v && !this.chain.includes(v)) this.set([...this.chain, v]);
	}

	protected render(): TemplateResult {
		return html`<h2>${this.heading}</h2>
			<p class="hint">
				dispatch walks this order as its fallback chain — first entry first; a
				dead lane re-dispatch advances to the next; the same-model tail rides
				claude's --fallback-model; claude is appended as the last resort unless
				enabled_executors blocks it. Empty list = claude only.
			</p>
			<ol aria-label="executor preference order">
				${this.chain.map((v, i) => this.row(v, i))}
			</ol>
			<div class="add">
				<div>
					<label for="exadd">add executor (catalog)</label>
					<select id="exadd">
						${Array.from(
							new Set(this.options.map((o) => o.group ?? "Other")),
						).map(
							(group) => html`<optgroup label=${group}>
								${this.options
									.filter((o) => (o.group ?? "Other") === group)
									.map(
										(o) => html`<option
											value=${o.value}
											?disabled=${this.chain.includes(o.value)}
										>
											${o.label}
										</option>`,
									)}
							</optgroup>`,
						)}
					</select>
				</div>
				<button type="button" @click=${() => this.add()}>add</button>
			</div>`;
	}

	private row(v: string, i: number): TemplateResult {
		return html`<li data-v=${v}>
			<span class="exv">${v}</span>
			<button
				type="button"
				aria-label="move up ${v}"
				@click=${() => this.move(i, -1)}
			>
				↑
			</button>
			<button
				type="button"
				aria-label="move down ${v}"
				@click=${() => this.move(i, 1)}
			>
				↓
			</button>
			<button
				type="button"
				aria-label="remove ${v}"
				@click=${() => this.set(this.chain.filter((_, k) => k !== i))}
			>
				✕
			</button>
		</li>`;
	}
}

if (!customElements.get("klh-executor-editor"))
	customElements.define("klh-executor-editor", KlhExecutorEditor);

// ─── <klh-diff-view> — the settings preview diff ──────────────────────────
class KlhDiffView extends LitElement {
	static properties = {
		heading: { type: String },
		lines: { type: Array },
	};
	static styles = [
		cardCss,
		css`
			pre {
				background: var(--klh-bg);
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				padding: 10px 12px;
				font: 11px/1.5 var(--klh-font-mono);
				overflow: auto;
				margin: 0;
			}
			.add {
				color: var(--klh-ok-hi);
				display: block;
			}
			.del {
				color: var(--klh-danger-ink);
				display: block;
			}
			.ctx {
				display: block;
			}
		`,
	];

	declare heading: string;
	declare lines: string[];

	constructor() {
		super();
		this.heading = "";
		this.lines = [];
	}

	private cls(l: string): string {
		return l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : "ctx";
	}

	protected render(): TemplateResult {
		const body = this.lines.length
			? this.lines.map((l) => html`<span class=${this.cls(l)}>${l}</span>`)
			: html`no textual change`;
		return html`<h2>${this.heading}</h2>
			<pre class="diff">${body}</pre>`;
	}
}

if (!customElements.get("klh-diff-view"))
	customElements.define("klh-diff-view", KlhDiffView);
