// hooks/lib/ui/klh-status-grid.ts — W581 compact status grid.
// Dense grid of state cells for hub/leaf rollups (the NAS/desktop/local
// posture at a glance): one cell per service, restrained semantic tones.
// `cells` property: [{ label, state, detail? }]  state: ok|warn|bad|off
// Clicking a cell emits `klh-cell-select` {label}.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

export interface StatusCell {
	readonly label: string;
	readonly state: string; // ok | warn | bad | off
	readonly detail?: string;
}

const STATES = ["ok", "warn", "bad", "off"] as const;

export const cellState = (v: unknown): string => {
	const s = String(v ?? "").toLowerCase();
	return (STATES as readonly string[]).includes(s) ? s : "off";
};

export class KlhStatusGrid extends LitElement {
	static properties = { cells: { type: Array } };

	static styles = css`
		:host {
			display: block;
			font: var(--klh-text-xs, 10px)/1.5 var(--klh-font-mono);
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(
				auto-fill,
				minmax(150px, 1fr)
			);
			gap: 6px;
		}
		button {
			display: flex;
			align-items: center;
			gap: 7px;
			text-align: left;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: var(--klh-radius, 2px);
			padding: 6px 9px;
			color: var(--klh-ink, #e8e6e1);
			font: inherit;
			cursor: pointer;
		}
		button:hover {
			border-color: var(--klh-edge-hover, rgba(255, 255, 255, 0.4));
		}
		.led {
			flex: none;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		.ok .led {
			background: var(--klh-ok, #5c7a35);
			border-color: var(--klh-ok, #5c7a35);
		}
		.warn .led {
			background: none;
			border-color: var(--klh-accent, #d8900f);
		}
		.bad .led {
			background: var(--klh-danger, #af2f12);
			border-color: var(--klh-danger, #af2f12);
		}
		.off .led {
			background: none;
		}
		.off {
			color: var(--klh-dim, #98958e);
		}
		.lbl {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.det {
			margin-left: auto;
			color: var(--klh-dim, #98958e);
			flex: none;
		}
	`;

	declare cells: StatusCell[];

	constructor() {
		super();
		this.cells = [];
	}

	protected render(): TemplateResult {
		if (!this.cells.length)
			return html`<p class="empty">no services in scope</p>`;
		return html`<div class="grid" role="list">
			${this.cells.map(
				(cell) => html`<button
					type="button"
					role="listitem"
					class=${cellState(cell.state)}
					title=${cell.detail ?? nothing}
					@click=${() =>
						this.dispatchEvent(
							new CustomEvent("klh-cell-select", {
								detail: { label: cell.label },
								bubbles: true,
								composed: true,
							}),
						)}
				>
					<span class="led" aria-hidden="true"></span>
					<span class="lbl">${cell.label}</span>
					${
						cell.detail
							? html`<span class="det">${cell.detail}</span>`
							: nothing
					}
				</button>`,
			)}
		</div>`;
	}
}

customElements.define("klh-status-grid", KlhStatusGrid);

declare global {
	interface HTMLElementTagNameMap {
		"klh-status-grid": KlhStatusGrid;
	}
}
