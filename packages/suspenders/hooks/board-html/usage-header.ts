// hooks/board-html/usage-header.ts — <klh-usage-header> (W695.3.4), moved
// verbatim from usage-panels.ts in the W1298 decomposition: back bar, title,
// filter chips. Chip links stay native <a href> (the query string is the view
// state and must work without JS); the server computes every href.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type { UsageChip, UsageHeaderPanel } from "../bin/usage-chrome.ts";
import { readPanels } from "./usage-shared.ts";

// ─── <klh-usage-header> — back bar, title, filter chips (W695.3.4) ─────────
// Chip links stay native <a href> (the query string is the view state and
// must work without JS); the server computes every href into the payload.
export class KlhUsageHeader extends LitElement {
	static properties = { header: { type: Object, state: true } };

	declare header: UsageHeaderPanel | null;

	constructor() {
		super();
		this.header = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.header = readPanels()?.header ?? null;
	}

	private chips(
		label: string,
		chips: UsageChip[],
		cls: string,
	): TemplateResult {
		return html`<span class="ufgroup" data-label=${label}
			>${chips.map(
				(c) =>
					html`<a class="${cls}${c.on ? " on" : ""}" href=${c.href}
						>${c.label}</a
					>`,
			)}</span
		>`;
	}

	private body(h: UsageHeaderPanel): TemplateResult {
		return html`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${h.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window", h.windows, "ufilter")}
				${this.chips("team", h.teams, "ufchip")}
				${this.chips("dept", h.depts, "ufchip")}
				${h.filtered ? html`<span class="uon">${h.filtered}</span>` : nothing}
				<span class="uon">${h.status}</span>
			</div>`;
	}

	protected render(): TemplateResult {
		return html`${this.header ? this.body(this.header) : nothing}`;
	}
}

// header chrome — back bar, title, filter chips (moved from usage-chrome.ts)
KlhUsageHeader.styles = css`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #d8900f);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 0 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter,
	.ufchip {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on,
	.ufchip.on {
		color: var(--klh-accent, #d8900f);
		border-color: var(--klh-accent, #d8900f);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #d8900f);
	}
`;
