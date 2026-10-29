// hooks/board-html/klh-posture-panel.ts — W1315.4: the persisted posture
// panel (Lit, UI law: every string is a lit text binding).
// A native <select> for the base posture + native checkbox for the dev
// override, saved through the CAS endpoint (/api/posture/selection) so a
// concurrent write lands as a reload-and-reapply note, never a silent
// overwrite. The effective view (?project=.prefer walk) shows overrides,
// their source paths, per-entry ceilings/occupancy and held/disabled state.
// Selecting a base posture never rewrites a repo .prefer; changes affect
// new launches only — no lane is cancelled from this panel.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";

type Entry = {
	hub: string;
	model: string;
	policy: "OFF" | "CAN" | "MUST";
	lanes: number | "MAX";
	occupancy: number;
	held: boolean;
	disabled: boolean;
};
type View = {
	configured: boolean;
	revision: string;
	unconfiguredReason?: string;
	selection?: { fleet: string; posture: string; developmentOverride: boolean };
	postures?: string[];
	effective?: {
		posture: string;
		developmentOverride: boolean;
		overridden: boolean;
		overrides: string[];
		sources: Record<string, string>;
		entries: Entry[];
	};
};

class KlhPosturePanel extends LitElement {
	static properties = {
		view: { state: true },
		err: { state: true },
		note: { state: true },
	};

	// `declare` only — a real field declaration (initializer or not) would
	// shadow Lit's reactive accessors and silently freeze the render
	// (lit-class-field-reactivity)
	declare view: View | null;
	declare err: string | null;
	declare note: string | null;

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
		.row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			align-items: center;
			padding: 4px 0;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		.err {
			color: #e07a5f;
		}
		.badge {
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 4px;
			padding: 0 4px;
		}
		.badge.held {
			border-color: #d9a53a;
			color: #d9a53a;
		}
		.badge.off {
			border-color: #e07a5f;
			color: #e07a5f;
		}
		select,
		button {
			font: inherit;
			color: var(--klh-ink, #e8e4da);
			background: var(--klh-surface, #23211d);
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			padding: 2px 8px;
		}
	`;

	async refresh(): Promise<void> {
		try {
			const res = await fetch("/api/posture");
			const body = (await res.json().catch(() => null)) as
				| (View & { error?: string })
				| null;
			if (!res.ok) this.err = body?.error ?? `HTTP ${res.status}`;
			else {
				this.view = body;
				this.err = null;
			}
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		}
	}

	/** CAS save: POST the new selection with the revision we rendered from.
	 * 412 = someone wrote first — reload and ask the operator to re-apply. */
	private async save(selection: {
		fleet: string;
		posture: string;
		developmentOverride: boolean;
	}): Promise<void> {
		if (!this.view?.configured || !selection) return;
		const res = await fetch("/api/posture/selection", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ selection, revision: this.view.revision }),
		});
		const body = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			revision?: string;
		} | null;
		if (res.status === 412) {
			this.note = "changed elsewhere — re-apply";
			await this.refresh();
			return;
		}
		if (!res.ok) {
			this.err = body?.error ?? `HTTP ${res.status}`;
			return;
		}
		this.note = null;
		if (body?.revision && this.view) this.view.revision = body.revision;
		await this.refresh();
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.refresh();
	}

	protected render(): TemplateResult {
		const v = this.view;
		return html`<details>
			<summary>
				Posture
				<span class="dim"> base selection, effective overrides, holds</span>
			</summary>
			${
				v == null
					? html`<p class="dim">loading…</p>`
					: v.configured
						? this.renderConfigured(v)
						: html`<p class="dim">${v.unconfiguredReason ?? "not migrated"}</p>`
			}
			${this.err === null ? nothing : html`<p class="err">${this.err}</p>`}
			${this.note === null ? nothing : html`<p class="dim">${this.note}</p>`}
		</details>`;
	}

	private renderConfigured(v: View): TemplateResult {
		const sel = v.selection;
		if (!sel || !v.effective) return html`<p class="err">malformed view</p>`;
		return html`
			<div class="row">
				<label>
					base
					<select
						@change=${(e: Event) => {
							const posture = (e.target as HTMLSelectElement).value;
							this.save({ ...sel, posture });
						}}
					>
						${(v.postures ?? []).map(
							(p) =>
								html`<option value=${p} ?selected=${p === sel.posture}>
									${p}
								</option>`,
						)}
					</select>
				</label>
				<span>
					effective <strong>${v.effective.posture}</strong>
					${
						v.effective.overridden
							? html`<span class="badge">override</span>`
							: nothing
					}
				</span>
				<label>
					<input
						type="checkbox"
						?checked=${sel.developmentOverride}
						@change=${(e: Event) => {
							const on = (e.target as HTMLInputElement).checked;
							this.save({ ...sel, developmentOverride: on });
						}}
					/>
					dev override
				</label>
			</div>
			${
				v.effective.overrides.length === 0
					? nothing
					: html`<p class="dim">
						.prefer sources:
						${v.effective.overrides.map(
							(o, i) => html`${i > 0 ? ", " : nothing}<code>${o}</code>`,
						)}
					</p>`
			}
			<details>
				<summary class="dim">
					entries (${v.effective.entries.length})
				</summary>
				${this.entriesTable(v.effective.entries)}
			</details>
		`;
	}

	private entriesTable(entries: Entry[]): TemplateResult {
		return html`
			<table>
				<thead>
					<tr>
						<th>hub</th>
						<th>model</th>
						<th>policy</th>
						<th>lanes</th>
						<th>active</th>
					</tr>
				</thead>
				<tbody>
					${entries.map(
						(e) => html`
							<tr>
								<td>${e.hub}</td>
								<td>${e.model}</td>
								<td>${e.policy}</td>
								<td>${e.lanes === "MAX" ? "MAX" : `${e.lanes}`}</td>
								<td>
									${`${e.occupancy}`}
									${e.held ? html`<span class="badge held">held</span>` : nothing}
									${
										e.disabled
											? html`<span class="badge off">disabled</span>`
											: nothing
									}
								</td>
							</tr>
						`,
					)}
				</tbody>
			</table>
		`;
	}
}

customElements.define("klh-posture-panel", KlhPosturePanel);
