// hooks/board-html/usage-activity.ts — <klh-usage-activity> (W243), moved
// verbatim from usage-panels.ts in the W1298 decomposition: the decant-shape
// work-mix panel (weekly history + per-lane breakdown).
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type {
	UsageActivityCell,
	UsageActivityLane,
	UsageActivityWeek,
	UsagePanels,
} from "../bin/usage-chrome.ts";
import { fmtTok, panelCss, pct1, readPanels } from "./usage-shared.ts";

// ─── <klh-usage-activity> — W243 decant-shape panel (weekly + lanes) ───────
const ACT_COLOR: Record<string, string> = {
	context: "#3987e5",
	planning: "#199e70",
	code: "#d95926",
	communicating: "#c98500",
};

export class KlhUsageActivity extends LitElement {
	static properties = {
		panel: { type: Object, state: true },
	};

	declare panel: UsagePanels["activity"] | null;

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readPanels()?.activity ?? null;
	}

	protected render(): TemplateResult {
		const p = this.panel;
		if (!p) return html``;
		if ("empty" in p)
			return html`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${p.empty}</p>
			</div>`;
		return this.body(p);
	}

	private body(
		p: Exclude<NonNullable<UsagePanels["activity"]>, { empty: string }>,
	): TemplateResult {
		const latest = [...p.weekly].sort((a, b) => b.d.localeCompare(a.d))[0];
		return html`<div class="upanel">
			<div class="uhead">
				<h2>WORK MIX</h2>
				<p class="ufoot">${latest ? `Week of ${latest.d}` : "No weekly data"} · ${p.lanes.length} ${p.lanes.length === 1 ? "lane" : "lanes"}</p>
			</div>
			${latest ? this.mix(latest) : html`<p class="uempty">No classified activity yet.</p>`}
			<details class="mixdetails">
				<summary>Weekly history and lane breakdown</summary>
				<p class="ufoot">${p.foot}</p>
				${this.weekly(p.weekly)}
				${this.lanes(p.lanes)}
			</details>
		</div>`;
	}

	private mix(week: UsageActivityWeek): TemplateResult {
		return html`<div class="mixoverview">
			<div class="mixbar" role="img" aria-label=${week.cells.map((c) => `${c.key} ${pct1(c.share)}`).join(", ")}>
				${week.cells.map((c) => html`<span style=${`width:${pct1(c.share)};background:${ACT_COLOR[c.key] ?? "#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${week.cells.map((c) => html`<span><i style=${`background:${ACT_COLOR[c.key] ?? "#888"}`}></i>${c.key} <b>${pct1(c.share)}</b></span>`)}
			</div>
		</div>`;
	}

	private weekly(weeks: UsageActivityWeek[]): TemplateResult {
		return html`<table class="uacts">
			<thead>
				<tr>
					<th>week</th>
					<th class="unum">cost</th>
					<th>context · planning · code · communicating</th>
					<th class="unum">orient</th>
				</tr>
			</thead>
			<tbody>
				${weeks.map(
					(w) => html`<tr>
					<td>${w.d}</td>
					<td class="unum">${fmtTok(w.cost)}</td>
					<td style="width:44%">${w.cells.map((c, i) => this.cell(c, i))}</td>
					<td class="unum">${pct1(w.orient)}</td>
				</tr>`,
				)}
			</tbody>
		</table>`;
	}

	private cell(c: UsageActivityCell, i: number): TemplateResult {
		const sep = i > 0 ? html`<span class="usep">·</span>` : nothing;
		if (!c.share) return html`${sep}<span class="uempty">—</span>`;
		const p = pct1(c.share);
		return html`${sep}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${p};background:${ACT_COLOR[c.key] ?? "#888"}`}
					title=${`${c.key}: ${p}`}
				></i></span
			><span class="unum">${p}</span></span
		>`;
	}

	private lanes(ls: UsageActivityLane[]): TemplateResult {
		const rows = ls.length
			? ls.map((l) => this.laneRow(l))
			: [
					html`<tr>
						<td colspan="6" class="uempty">
							no classified activity yet — first harvest fills this table
						</td>
					</tr>`,
				];
		return html`<table class="uacts" style="margin-top:10px">
			<thead>
				<tr>
					<th>lane</th>
					<th>context share</th>
					<th class="unum">orient</th>
					<th class="unum">searches/req</th>
					<th class="unum">cost</th>
					<th class="unum">req</th>
				</tr>
			</thead>
			<tbody>
				${rows}
			</tbody>
		</table>`;
	}

	private laneRow(l: UsageActivityLane): TemplateResult {
		return html`<tr>
			<td><b>${l.actor}</b></td>
			<td>${this.cell(l.cells[0], 0)}</td>
			<td class="unum">${pct1(l.orient)}</td>
			<td class="unum">${l.spr}</td>
			<td class="unum">${fmtTok(l.cost)}</td>
			<td class="unum">${fmtTok(l.req)}</td>
		</tr>`;
	}
}

// activity chrome — the ucwrap cell layout keeps bar + pct on one line
KlhUsageActivity.styles = [
	panelCss,
	css`
		.mixbar { display:flex; height:12px; overflow:hidden; border-radius:3px; background:var(--klh-edge, #555); }
		.mixbar span { display:block; height:100%; }
		.mixlegend { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:9px; font-size:11px; color:var(--klh-dim, #98958e); }
		.mixlegend span { display:inline-flex; align-items:center; gap:5px; }
		.mixlegend i { display:inline-block; width:7px; height:7px; border-radius:1px; }
		.mixlegend b { color:var(--klh-ink, #eee); font-weight:600; }
		.mixdetails { margin-top:12px; border-top:1px solid var(--klh-edge, #555); padding-top:9px; }
		.mixdetails summary { cursor:pointer; color:var(--klh-ink-2, #ccc); font-size:12px; }
		.mixdetails[open] summary { margin-bottom:10px; }
		.ucwrap {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.usep {
			color: var(--klh-dim, #98958e);
			margin: 0 4px;
		}
		:host {
			display: block;
		}
	`,
];
