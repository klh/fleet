// hooks/board-html/usage-actors.ts — <klh-usage-actors>, moved verbatim from
// usage-panels.ts in the W1298 decomposition: the per-actor table with
// segmented bars, search filter, and the per-model drill-down rows.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type { UsageActorRow } from "../bin/usage-chrome.ts";
import {
	fmtTok,
	panelCss,
	readPanels,
	readSlot,
	segT,
	slotColor,
} from "./usage-shared.ts";

// ─── <klh-usage-actors> — per-actor table with segmented bars + drill-down ─

export class KlhUsageActors extends LitElement {
	static properties = {
		rows: { type: Array, state: true },
		query: { type: String, state: true },
	};

	declare rows: UsageActorRow[];
	declare query: string;
	private slot: Record<string, string> = {};

	constructor() {
		super();
		this.rows = [];
		this.query = "";
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.rows = readPanels()?.actors?.rows ?? [];
		this.slot = readSlot();
	}

	protected render(): TemplateResult {
		const p = readPanels()?.actors;
		if (!p?.rows.length)
			return html`<div class="upanel"><h2>ACTORS</h2><p class="uempty">No actor usage in this window.</p></div>`;
		return this.body(p.rows);
	}

	private body(rows: UsageActorRow[]): TemplateResult {
		const q = this.query.trim().toLocaleLowerCase();
		const visible = q
			? rows.filter((row) =>
					[row.actor, ...row.chips, ...row.models.map((m) => m.m)].some(
						(value) => value.toLocaleLowerCase().includes(q),
					),
				)
			: rows;
		return html`<div class="upanel">
			<div class="actor-head">
				<h2>ACTORS · ${String(visible.length)} OF ${String(rows.length)}</h2>
				<label>Search actor or model
					<input type="search" .value=${this.query}
						@input=${(event: Event) => {
							this.query = (event.target as HTMLInputElement).value;
						}}
						placeholder="Name, team, or model" />
				</label>
			</div>
			${!visible.length ? html`<p class="uempty" role="status">No actors match this search.</p>` : nothing}
			<div class="table-scroll"><table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${visible.map((row) => this.row(row))}
				</tbody>
			</table></div>
		</div>`;
	}

	private row(row: UsageActorRow): TemplateResult {
		const chips = [...(row.demo ? ["synthetic demo"] : []), ...row.chips].map(
			(c) => html`<span class="uchip">${c}</span>`,
		);
		return html`<tr class="uact">
				<td>
					<b>${row.actor}</b>
					${chips}
				</td>
				<td>
					<div class="ubar" style=${`width:${row.barW}%`}>
						${row.segs.map((seg) => segT(seg, row.total, this.slot))}
					</div>
				</td>
				<td class="unum">${fmtTok(row.total)}</td>
				<td class="unum">${fmtTok(row.rq)}</td>
			</tr>
			${this.detail(row.models)}`;
	}

	private detail(models: UsageActorRow["models"]): TemplateResult {
		return html`<tr class="udetail">
			<td colspan="4">
				<details>
					<summary>per-model</summary>
					<table class="umtab">
						<thead>
							<tr>
								<th>model</th>
								<th class="unum">tokens</th>
								<th class="unum">req</th>
							</tr>
						</thead>
						<tbody>${models.map((m) => this.mrow(m))}</tbody>
					</table>
				</details>
			</td>
		</tr>`;
	}

	private mrow(m: UsageActorRow["models"][number]): TemplateResult {
		return html`<tr>
			<td>
				<i
					class="udot"
					style=${`background:${slotColor(this.slot, m.g)}`}
				></i
				>${m.m}
			</td>
			<td class="unum">${fmtTok(m.tok)}</td>
			<td class="unum">${fmtTok(m.rq)}</td>
		</tr>`;
	}
}

KlhUsageActors.styles = [
	panelCss,
	css`
		.actor-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
		.actor-head h2 { margin:0; }
		.actor-head label { display:flex; align-items:center; gap:8px; color:var(--klh-dim); font-size:11px; }
		.actor-head input { min-width:210px; padding:6px 8px; border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); color:var(--klh-ink); font:inherit; }
		.actor-head input:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.table-scroll { overflow-x:auto; }
		.table-scroll > table { min-width:560px; }
		@media (max-width:620px) { .actor-head label, .actor-head input { width:100%; } }
		tr.udetail td {
			padding-top: 0;
			border-bottom: none;
		}
		tr.udetail details {
			font-size: 11px;
			color: var(--klh-dim, #98958e);
		}
		tr.udetail summary {
			cursor: pointer;
		}
		table.umtab {
			margin: 6px 0 10px;
			border-collapse: collapse;
		}
		table.umtab td,
		table.umtab th {
			padding: 2px 10px 2px 0;
			font-size: 11px;
			text-align: left;
			color: var(--klh-ink-2, #c9c6bf);
		}
		:host {
			display: block;
		}
	`,
];
