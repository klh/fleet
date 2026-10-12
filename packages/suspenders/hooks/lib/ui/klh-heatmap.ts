// hooks/lib/ui/klh-heatmap.ts — W581 contribution heatmap.
// GitHub-style activity grid, MONOCHROME ink ramp (no hue): rows = lanes
// or hubs, rows[i].cells aligned 1:1 with `days` labels; day labels print
// on a 7-column cadence. Cell semantics ride title + aria-label; legend
// shows "less…more". Zero days render as outline cells. Real events only.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

export interface HeatRow {
	readonly id: string;
	readonly label: string;
	readonly hub?: string;
	readonly cells: readonly number[];
}

// monochrome intensity ramp — ink token at fixed opacities, theme-adaptive
const INK = [
	"transparent",
	"color-mix(in srgb, var(--klh-ink, #e8e6e1) 18%, transparent)",
	"color-mix(in srgb, var(--klh-ink, #e8e6e1) 38%, transparent)",
	"color-mix(in srgb, var(--klh-ink, #e8e6e1) 62%, transparent)",
	"color-mix(in srgb, var(--klh-ink, #e8e6e1) 92%, transparent)",
];

export const intensityStep = (count: number, max: number): number => {
	if (count <= 0 || max <= 0) return 0;
	return Math.min(4, Math.ceil((count / max) * 4));
};

export class KlhHeatmap extends LitElement {
	static properties = { rows: { type: Array }, days: { type: Array } };

	static styles = css`
		:host {
			display: block;
			font: var(--klh-text-xs, 10px)/1.5 var(--klh-font-mono);
			color: var(--klh-dim, #98958e);
		}
		.scroll {
			overflow-x: auto;
			padding-bottom: 4px;
		}
		table {
			border-collapse: separate;
			border-spacing: 3px;
		}
		th {
			font-weight: 400;
			text-align: left;
			padding: 0 6px 0 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 180px;
		}
		td.c,
		.legend .c {
			width: 11px;
			height: 11px;
			border-radius: 2px;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge-faint, rgba(255, 255, 255, 0.07));
		}
		.axis {
			display: flex;
			gap: 3px;
		}
		.axis .d {
			width: 11px;
			flex: none;
			white-space: nowrap;
		}
		.legend {
			display: flex;
			align-items: center;
			gap: 3px;
			margin-top: 8px;
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}
	`;

	declare rows: HeatRow[];
	declare days: string[];

	constructor() {
		super();
		this.rows = [];
		this.days = [];
	}

	private cellHtml(
		v: number,
		max: number,
		label: string,
		day: string,
	): TemplateResult {
		const s = intensityStep(v, max);
		const when = day || "?";
		return html`<td
			class="c"
			style=${INK[s]}
			title=${label + " · " + when + " — " + String(v) + " events"}
			aria-label=${label + " " + when + ": " + String(v) + " events"}
		></td>`;
	}

	private rowHtml(r: HeatRow, max: number): TemplateResult {
		return html`<tr>
			<th scope="row" title=${r.hub ? r.label + " · hub " + r.hub : r.label}>
				${r.label}${r.hub ? html` · ${r.hub}` : nothing}
			</th>
			${r.cells.map((v, i) => this.cellHtml(v, max, r.label, this.days[i] ?? ""))}
		</tr>`;
	}

	protected render(): TemplateResult {
		const rows = this.rows.filter((r) => r.cells.length);
		if (!rows.length || !this.days.length)
			return html`<p>no activity in range</p>`;
		const max = Math.max(...rows.flatMap((r) => [...r.cells]), 1);
		return html`
			<div class="scroll">
				<table>
					<tbody>
						${rows.map((r) => this.rowHtml(r, max))}
					</tbody>
				</table>
				<div class="axis">
					${this.days.map((d, i) => html`<span class="d">${i % 7 === 0 ? d : ""}</span>`)}
				</div>
			</div>
			<div class="legend">
				less
				${[0, 1, 2, 3, 4].map((s) => html`<span class="c" style=${INK[s]}></span>`)}
				more
			</div>
		`;
	}
}

customElements.define("klh-heatmap", KlhHeatmap);

declare global {
	interface HTMLElementTagNameMap {
		"klh-heatmap": KlhHeatmap;
	}
}
