// hooks/board-html/klh-prompt-preview.ts — W270 orchestrate prompt preview
// (Lit, UI law: no innerHTML — every string is a lit text binding). Lives
// under the orchestrate field: the transform toggles (native checkboxes in a
// <details>) and, when prompt.debug/prompt.log is on, a read-only preview of
// what WILL be dispatched. The legacy orchestrate chunk calls prepare() and
// listens for `klh-dispatch`; "dispatch anyway" is always offered, even when
// the preview fails, so the flow is never trapped.
import { LitElement, html, css, nothing, type TemplateResult } from "lit";

type Settings = Record<
	"prompt.condense" | "prompt.enhance" | "prompt.debug" | "prompt.log",
	boolean
>;
type Block = { label: string; text: string; bytes: number };
type View = {
	final: string;
	finalBytes: number;
	ran: { condense: boolean; enhance: boolean };
	enhanceNote: string | null;
	stages?: Block[];
	injected?: Block[];
	wireBytes?: number;
};

const TOGGLES: [keyof Settings, string][] = [
	["prompt.condense", "condense"],
	["prompt.enhance", "enhance (local LLM)"],
	["prompt.debug", "debug preview"],
	["prompt.log", "log all stages"],
];

const DEFAULTS: Settings = {
	"prompt.condense": true,
	"prompt.enhance": false,
	"prompt.debug": false,
	"prompt.log": false,
};

class KlhPromptPreview extends LitElement {
	static properties = {
		settings: { state: true },
		view: { state: true },
		busy: { state: true },
		err: { state: true },
		sent: { state: true },
	};

	static styles = css`
		:host {
			display: block;
			margin: 4px 0;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e4da);
		}
		summary {
			cursor: pointer;
			color: var(--klh-dim, #97917f);
		}
		.toggles {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			padding: 4px 0;
		}
		.pv {
			margin-top: 6px;
			padding: 8px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-left: 3px solid var(--klh-accent, #d9a53a);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
		}
		.hd {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: baseline;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		pre {
			margin: 4px 0;
			padding: 6px 8px;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 16em;
			overflow: auto;
			font: 12px/1.4 ui-monospace, monospace;
			background: rgb(0 0 0 / 0.18);
			border-radius: 4px;
			user-select: text;
		}
		.err {
			color: #e07a5f;
		}
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 6px;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button.go {
			border-color: var(--klh-accent, #d9a53a);
			font-weight: 600;
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
	`;

	declare settings: Settings;
	declare view: View | null;
	declare busy: boolean;
	declare err: string | null;
	declare sent: boolean;
	private project = "";
	private goal = "";
	private previewId: string | null = null;

	constructor() {
		super();
		this.settings = { ...DEFAULTS };
		this.view = null;
		this.busy = false;
		this.err = null;
		this.sent = false;
	}

	/** true when submit should preview first (debug or log mode) */
	get gated(): boolean {
		return this.settings["prompt.debug"] || this.settings["prompt.log"];
	}

	/** a preview for this exact goal is showing and not yet dispatched */
	ready(goal: string): boolean {
		return !this.busy && !this.sent && this.goal === goal && !!this.project;
	}

	connectedCallback(): void {
		super.connectedCallback();
		void this.loadSettings();
	}

	private async loadSettings(): Promise<void> {
		try {
			const r = await fetch("/api/prompt/settings");
			const d = (await r.json()) as { settings?: Settings };
			if (d.settings) this.settings = { ...DEFAULTS, ...d.settings };
		} catch {
			// defaults stand — the board still dispatches
		}
	}

	private async toggle(key: keyof Settings, on: boolean): Promise<void> {
		const prev = this.settings;
		this.settings = { ...prev, [key]: on };
		try {
			const r = await fetch("/api/prompt/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ [key]: on }),
			});
			const d = (await r.json()) as { settings?: Settings; error?: string };
			if (!r.ok || !d.settings) throw new Error(d.error ?? `HTTP ${r.status}`);
			this.settings = { ...DEFAULTS, ...d.settings };
		} catch (e) {
			this.settings = prev;
			this.err = `settings not saved: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async prepare(project: string, goal: string): Promise<void> {
		this.project = project;
		this.goal = goal;
		this.previewId = null;
		this.view = null;
		this.err = null;
		this.sent = false;
		this.busy = true;
		try {
			const r = await fetch("/api/orchestrate/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project, goal }),
				signal: AbortSignal.timeout(30_000),
			});
			const d = (await r.json()) as {
				ok?: boolean;
				previewId?: string;
				preview?: View;
				error?: string;
			};
			if (!r.ok || !d.ok || !d.preview)
				throw new Error(d.error ?? `HTTP ${r.status}`);
			this.view = d.preview;
			this.previewId = d.previewId ?? null;
		} catch (e) {
			this.err = `preview failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
		}
	}

	clear(): void {
		this.view = null;
		this.err = null;
		this.sent = false;
		this.goal = "";
		this.project = "";
		this.previewId = null;
	}

	dispatch(): void {
		if (this.busy || this.sent || !this.project) return;
		this.sent = true;
		this.dispatchEvent(
			new CustomEvent("klh-dispatch", {
				bubbles: true,
				composed: true,
				detail: {
					project: this.project,
					goal: this.goal,
					previewId: this.previewId,
				},
			}),
		);
	}

	private block(b: Block, open: boolean): TemplateResult {
		return html`<details ?open=${open}>
			<summary>${b.label} · ${b.bytes} B</summary>
			<pre>${b.text}</pre>
		</details>`;
	}

	private summary(): string {
		const on = TOGGLES.filter(([k]) => this.settings[k]).map(([, l]) => l);
		return `prompt transforms · ${on.length ? on.join(", ") : "all off"}`;
	}

	private body(): TemplateResult | typeof nothing {
		if (!this.busy && !this.view && !this.err) return nothing;
		const v = this.view;
		return html`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent ? "dispatched" : "will dispatch"}</strong>
				${
					v
						? html`<span class="dim"
								>${v.finalBytes} B · condense ${v.ran.condense ? "ran" : "off"} ·
								enhance ${v.ran.enhance ? "ran" : "off"}${v.wireBytes ? ` · ${v.wireBytes} B on the wire` : ""}</span
							>`
						: nothing
				}
			</div>
			${this.busy ? html`<div class="dim">preparing preview…</div>` : nothing}
			${this.err ? html`<div class="err">${this.err}</div>` : nothing}
			${v?.enhanceNote ? html`<div class="dim">${v.enhanceNote}</div>` : nothing}
			${v ? html`<pre aria-label="final prompt">${v.final}</pre>` : nothing}
			${
				v?.stages?.length
					? html`<div class="dim">stages</div>
							${v.stages.map((s) => this.block(s, false))}`
					: nothing
			}
			${
				v?.injected?.length
					? html`<div class="dim">injected context (appended to the prompt)</div>
							${v.injected.map((s) => this.block(s, false))}`
					: nothing
			}
			${
				this.sent || !this.project
					? nothing
					: html`<div class="actions">
							<button
								class="go"
								type="button"
								?disabled=${this.busy}
								@click=${this.dispatch}
							>
								dispatch anyway ⏎
							</button>
							<button type="button" @click=${this.clear}>cancel</button>
						</div>`
			}
		</section>`;
	}

	protected render(): TemplateResult {
		return html`
			<details>
				<summary>${this.summary()}</summary>
				<div class="toggles">
					${TOGGLES.map(
						([k, label]) => html`<label>
							<input
								type="checkbox"
								.checked=${this.settings[k]}
								@change=${(e: Event) =>
									this.toggle(k, (e.target as HTMLInputElement).checked)}
							/>
							${label}
						</label>`,
					)}
				</div>
			</details>
			${this.body()}
		`;
	}
}

customElements.define("klh-prompt-preview", KlhPromptPreview);
