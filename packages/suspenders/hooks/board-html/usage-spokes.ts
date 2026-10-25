// hooks/board-html/usage-spokes.ts — <klh-usage-spokes>, moved verbatim from
// usage-panels.ts in the W1298 decomposition: the federation per-spoke table.
import { css, html, LitElement, type TemplateResult } from "lit";
import type { UsagePanels } from "../bin/usage-chrome.ts";
import {
	fmtTok,
	panelCss,
	readPanels,
	readSlot,
	segT,
} from "./usage-shared.ts";

// ─── <klh-usage-spokes> — federation per-spoke table ───────────────────────
const SPOKES_EMPTY =
	"no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";

export class KlhUsageSpokes extends LitElement {
	static properties = { panel: { type: Object, state: true } };

	declare panel: UsagePanels["spokes"] | null;
	private slot: Record<string, string> = {};

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readPanels()?.spokes ?? null;
		this.slot = readSlot();
	}

	protected render(): TemplateResult {
		const p = readPanels()?.spokes;
		if (!p) return html``;
		if (!p.rows.length) return this.empty();
		return this.body(p.rows);
	}

	private empty(): TemplateResult {
		return html`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${SPOKES_EMPTY}</p>
		</div>`;
	}

	private body(
		rows: NonNullable<UsagePanels["spokes"]>["rows"],
	): TemplateResult {
		return html`<div class="upanel">
			<h2>SPOKES</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>spoke</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((row) => this.row(row))}
				</tbody>
			</table>
		</div>`;
	}

	private row(
		r: NonNullable<UsagePanels["spokes"]>["rows"][number],
	): TemplateResult {
		return html`<tr>
			<td>
				<b>${r.spoke}</b>
				<span class="uchip">${r.team}</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${r.barW}%`}>
					${r.segs.map((seg) => segT(seg, r.total, this.slot))}
				</div>
			</td>
			<td class="unum">${fmtTok(r.total)}</td>
			<td class="unum">${fmtTok(r.rq)}</td>
		</tr>`;
	}
}

// spokes chrome — panel + shared table/bar/chip css
KlhUsageSpokes.styles = [
	panelCss,
	css`
		:host {
			display: block;
		}
	`,
];
