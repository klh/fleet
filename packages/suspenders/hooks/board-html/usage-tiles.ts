// hooks/board-html/usage-tiles.ts — <klh-usage-tiles>, moved verbatim from
// usage-panels.ts in the W1298 decomposition: the stat tiles row and its
// .utile label/value type ramp.
import { css, html, LitElement, type TemplateResult } from "lit";
import type { UsageTile } from "../bin/usage-chrome.ts";
import { readPanels } from "./usage-shared.ts";

// ─── <klh-usage-tiles> — the stat tiles row ────────────────────────────────
export class KlhUsageTiles extends LitElement {
	static properties = { tiles: { type: Array, state: true } };

	declare tiles: UsageTile[];

	constructor() {
		super();
		this.tiles = [];
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.tiles = readPanels()?.tiles ?? [];
	}

	protected render(): TemplateResult {
		if (!this.tiles.length) return html``;
		return html`<div class="utiles">
			${this.tiles.map(
				(t) => html`<div class="utile">
					<div class="uv">${t.v}</div>
					<div class="uk">${t.k}</div>
				</div>`,
			)}
		</div>`;
	}
}

// tiles chrome — the .utile cells and their label/value type ramp
KlhUsageTiles.styles = css`
	:host {
		display: block;
	}
	.utile {
		flex: 1 1 150px;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 10px 14px;
	}
	.uv {
		font-size: 22px;
		font-weight: 600;
		color: var(--klh-ink, #e8e6e1);
		font-variant-numeric: tabular-nums;
		word-break: break-all;
	}
	.uk {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-top: 2px;
	}
	.utiles {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin: 14px 0;
	}
`;
