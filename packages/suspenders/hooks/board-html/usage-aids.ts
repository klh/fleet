// hooks/board-html/usage-aids.ts — <klh-usage-aids>, moved verbatim from
// usage-panels.ts in the W1298 decomposition: the aid-ROI panel, title/foot/
// empty payload-driven.
import { css, html, LitElement, type TemplateResult } from "lit";
import type { UsageAidsPanel } from "../bin/usage-chrome.ts";
import { fmtTok, panelCss, readPanels } from "./usage-shared.ts";

// ─── <klh-usage-aids> — aid-ROI panel, title/foot/empty payload-driven ─────
export class KlhUsageAids extends LitElement {
	static properties = {
		panel: { type: Object, state: true },
	};

	declare panel: UsageAidsPanel | null;

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readPanels()?.aids ?? null;
	}

	protected render(): TemplateResult {
		const p = this.panel;
		if (!p) return html``;
		if (p.empty)
			return html`<div class="upanel">
				<h2>${p.title}</h2>
				<p class="uempty">${p.empty}</p>
			</div>`;
		return this.body(p);
	}

	private body(p: UsageAidsPanel): TemplateResult {
		return html`<div class="upanel">
			${
				p.foot
					? html`<div class="uhead">
							<h2>${p.title}</h2>
							<p class="ufoot">${p.foot}</p>
						</div>`
					: html`<h2>${p.title}</h2>`
			}
			<table class="uacts">
				<thead>
					<tr>
						<th>aid</th>
						<th>domain</th>
						<th class="unum">injected</th>
						<th class="unum">skipped</th>
						<th class="unum">tok injected</th>
					</tr>
				</thead>
				<tbody>${p.rows.map((r) => this.arow(r))}</tbody>
			</table>
		</div>`;
	}

	private arow(r: UsageAidsPanel["rows"][number]): TemplateResult {
		return html`<tr>
			<td><b>${r.aid}</b></td>
			<td>${r.domain}</td>
			<td class="unum">${fmtTok(r.inj)}</td>
			<td class="unum">${fmtTok(r.skip)}</td>
			<td class="unum">${fmtTok(r.tok)}</td>
		</tr>`;
	}
}

KlhUsageAids.styles = [
	panelCss,
	css`
		:host {
			display: block;
		}
	`,
];
