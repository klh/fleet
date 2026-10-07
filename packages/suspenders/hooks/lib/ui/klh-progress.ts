// hooks/lib/ui/klh-progress.ts — W581 compact segmented progress.
// One hairline bar split into tonal segments (work-graph states, probe
// rollups) + an accessible legend with tabular counts. `segments` property:
//   [{ label, count, tone? }]  tone: dim|accent|ok|bad (default dim)
// total = Σ count; segments render in array order, left to right.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

export interface ProgressSegment {
	readonly label: string;
	readonly count: number;
	readonly tone?: string;
}

const TONE_BG: Record<string, string> = {
	dim: "var(--klh-edge-strong, rgba(255,255,255,.24))",
	accent: "var(--klh-accent, #d8900f)",
	ok: "var(--klh-ok, #5c7a35)",
	bad: "var(--klh-danger, #af2f12)",
};

export class KlhProgress extends LitElement {
	static properties = { segments: { type: Array } };

	static styles = css`
		:host {
			display: block;
			font: var(--klh-text-xs, 10px)/1.6 var(--klh-font-mono);
			color: var(--klh-dim, #98958e);
		}
		.bar {
			display: flex;
			height: 6px;
			border-radius: var(--klh-radius, 2px);
			overflow: hidden;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		}
		.seg {
			height: 100%;
			min-width: 2px;
		}
		.legend {
			display: flex;
			flex-wrap: wrap;
			gap: 2px 12px;
			margin-top: 5px;
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}
		.dot {
			display: inline-block;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			margin-right: 5px;
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			vertical-align: baseline;
		}
	`;

	declare segments: ProgressSegment[];

	constructor() {
		super();
		this.segments = [];
	}

	protected render(): TemplateResult {
		const total = this.segments.reduce((a, s) => a + (s.count || 0), 0);
		return html`
			<div
				class="bar"
				role="progressbar"
				aria-label=${`work states: ${String(total)} total`}
				aria-valuemin="0"
				aria-valuemax=${String(total)}
				aria-valuenow=${String(total)}
			>
				${this.segments.map((s) => {
					const pct = total > 0 ? ((s.count || 0) / total) * 100 : 0;
					return html`<span
						class="seg"
						style=${`width:${pct.toFixed(3)}%;background:${TONE_BG[s.tone ?? "dim"] ?? TONE_BG.dim}`}
						title=${`${s.label}: ${String(s.count)}`}
					></span>`;
				})}
			</div>
			<div class="legend">
				${this.segments.map(
					(s) =>
						html`<span>
							<span
								class="dot"
								style=${`background:${TONE_BG[s.tone ?? "dim"] ?? TONE_BG.dim}`}
							></span>
							${s.label}
							${s.count ? html`<b>${String(s.count)}</b>` : nothing}
						</span>`,
				)}
			</div>
		`;
	}
}

customElements.define("klh-progress", KlhProgress);

declare global {
	interface HTMLElementTagNameMap {
		"klh-progress": KlhProgress;
	}
}
