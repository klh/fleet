// hooks/board-html/usage-panels.ts — W652.3.1: the usage-dashboard panels as
// Lit components (the W184 staged migration lands here). The two SSR emitters
// (usage-page-html / federation-usage-html) stopped string-building panel
// interiors per request: they shape display-ready slices into the
// #usage-data payload's `panels` panels key and emit static <klh-usage-*> hosts;
// these components render them client-side. Plain-Lit per the W184 constraint
// set (bun 1.4.2 lowers decorators to stage 3 — static properties + declare +
// constructor init), shadow DOM, styling through the page's --klh-* tokens;
// no banned DOM-injection APIs — lit-html templates only. Built by `bun run build:vendor`
// into hooks/board-html/vendor/ (one shared lit runtime chunk) and served at
// /vendor/usage-panels.js by the board's /vendor/ allowlist.
//
// W658.4: the uPlot chart panels (stacked timeline + hour histogram) ride the
// same bundle as <klh-usage-charts> — light DOM by exception (uPlot manages
// its own canvas DOM inside the mount divs; the document-level uPlot chrome
// CSS must reach them), absorbing the retired bin/usage-charts.ts classic
// script: the component mounts the charts itself in firstUpdated, so the
// page carries one host and no inline render script.
import {
	type CSSResultGroup,
	css,
	html,
	LitElement,
	nothing,
	type TemplateResult,
} from "lit";
import type {
	UsageActivityCell,
	UsageActivityLane,
	UsageActivityWeek,
	UsageActorRow,
	UsageAidsPanel,
	UsageChip,
	UsageHeaderPanel,
	UsagePanels,
	UsageSeg,
} from "../bin/usage-chrome.ts";
import type { UsageReport } from "../lib/usage.ts";
// W695.3.5: the page head rides the same bundle (side-effect registers it)
import "./klh-usage-head.ts";
// W825: the cache drilldown rides the same bundle (side-effect registers it)
import "./usage-cache-drill.ts";

// ─── shared payload read ──────────────────────────────────────────────────
interface PanelRoot {
	slot: Record<string, string>;
	groups?: string[];
	timeline?: number[][];
	byHour?: number[][];
	panels?: UsagePanels;
}
const readPayload = (): Partial<PanelRoot> | null => {
	const el = document.getElementById("usage-data");
	if (!el) return null;
	try {
		return JSON.parse(el.textContent ?? "") as Partial<PanelRoot>;
	} catch {
		return null;
	}
};
const readPanels = (): UsagePanels | null => readPayload()?.panels ?? null;
const readSlot = (): Record<string, string> => readPayload()?.slot ?? {};

// ─── client-side formatting (payload carries honest numbers) ──────────────
// exported for the sibling client components (usage-cache-drill) — one
// formatting ramp across the usage bundle
export const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const fmtChartValue = (n: number | null | undefined): string =>
	n == null || !Number.isFinite(n) ? "—" : fmtTok(n);
export const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

// ─── shadow-scoped panel chrome (the u* classes each panel needs) ─────────
const panelCss: CSSResultGroup = css`
	.upanel {
		display: block;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 12px 14px 10px;
		margin-bottom: 14px;
	}
	.upanel h2 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim, #98958e);
	}
	.uhead {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.uhead .ufoot {
		margin: 0;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
	}
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	table.uacts {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.uacts td,
	table.uacts th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--klh-ink-2, #c9c6bf);
		white-space: nowrap;
	}
	.uchip {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 1px 6px;
		margin-left: 6px;
	}
	.ubar {
		display: flex;
		height: 12px;
		border-radius: 3px;
		overflow: hidden;
		min-width: 2px;
	}
	.ubar i {
		display: block;
		height: 100%;
	}
	.udot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: 6px;
	}
`;

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

// ─── <klh-usage-actors> — per-actor table with segmented bars + drill-down ─
const slotColor = (slot: Record<string, string>, g: string): string =>
	slot[g] ?? "#888";

// one segmented-bar <i> segment; actors + spokes share the shape
const segT = (
	seg: UsageSeg,
	total: number,
	slot: Record<string, string>,
): TemplateResult => {
	const width = seg.tok
		? `${((seg.tok / Math.max(1, total)) * 100).toFixed(2)}%`
		: "0";
	return html`<i
		style=${`width:${width};background:${slotColor(slot, seg.g)}`}
		title=${`${seg.g}: ${fmtTok(seg.tok)} tok`}
	></i>`;
};

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

// ─── <klh-usage-crosshub> — W365 per-hub rollup table ─────────────────────
const CROSSHUB_EMPTY =
	"no hub rollups — enumerate hubs in stack.yaml (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";

export class KlhUsageCrossHub extends LitElement {
	static properties = { panel: { type: Object, state: true } };

	declare panel: UsagePanels["crosshub"] | null;
	private slot: Record<string, string> = {};

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readPanels()?.crosshub ?? null;
		this.slot = readSlot();
	}

	protected render(): TemplateResult {
		const p = readPanels()?.crosshub;
		if (!p) return html``;
		if ("empty" in p)
			return html`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${p.empty}</p>
			</div>`;
		if (!p.rows.length) return this.empty();
		return this.body(p.rows);
	}

	private empty(): TemplateResult {
		return html`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${CROSSHUB_EMPTY}</p>
		</div>`;
	}

	private row(
		r: NonNullable<UsagePanels["crosshub"]>["rows"][number],
	): TemplateResult {
		if (r.degraded) {
			const reason = r.reason ?? "No response from this hub";
			const summary = /timed out|timeout/i.test(reason)
				? "No response before the hub timeout"
				: /typeerror|host is down|connection refused|unable to connect/i.test(
							reason,
						)
					? "Cannot reach this hub"
					: /hub answered (401|403)/.test(reason)
						? "Usage access denied"
						: /hub answered 404/.test(reason)
							? "Usage endpoint unavailable"
							: /no url/i.test(reason)
								? "No usage endpoint configured"
								: "Could not read usage from this hub";
			return html`<tr>
				<td>
					<b>${r.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${summary}
					<details><summary>Diagnostic</summary><code>${reason}</code></details>
				</td>
			</tr>`;
		}
		const barW = Math.max(2, (r.total / Math.max(1, ...this.rowTotals)) * 100);
		return html`<tr>
			<td>
				<b>${r.hub}</b>
				<span class="uchip">${r.via}</span>
				<span class="uchip">${String(r.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(barW)}%`}>
					${r.segs.map((seg) => segT(seg, r.total, this.slot))}
				</div>
			</td>
			<td class="unum">${fmtTok(r.total)}</td>
			<td class="unum">${fmtTok(r.rq)}</td>
		</tr>`;
	}

	private get rowTotals(): number[] {
		return (readPanels()?.crosshub?.rows ?? []).map((x) => x.total);
	}

	private body(
		rows: NonNullable<UsagePanels["crosshub"]>["rows"],
	): TemplateResult {
		return html`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>hub</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((row) => this.row(row))}
				</tbody>
			</table>
			<p class="ufoot">${readPanels()?.crosshub?.foot ?? ""}</p>
		</div>`;
	}
}

// crosshub chrome — panel + shared table/bar/chip css
KlhUsageCrossHub.styles = [
	panelCss,
	css`
		:host {
			display: block;
		}
		details {
			margin-top: 4px;
			font-size: 11px;
			color: var(--klh-dim);
		}
		details code {
			overflow-wrap: anywhere;
		}
	`,
];

// ─── <klh-usage-drilldown> — one real hourly bucket, actor and model ───────
export class KlhUsageDrilldown extends LitElement {
	static properties = {
		bucket: { type: Number, state: true },
		hours: { type: Array, state: true },
		report: { type: Object, state: true },
		error: { type: String, state: true },
		loading: { type: Boolean, state: true },
	};

	declare bucket: number;
	declare hours: number[];
	declare report: UsageReport | null;
	declare error: string;
	declare loading: boolean;
	private dayKey(hour: number): string {
		const d = new Date(hour);
		const p = (n: number): string => String(n).padStart(2, "0");
		return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	}

	private dayLabel(day: string): string {
		const [year, month, date] = day.split("-");
		return `${date}.${month}.${year?.slice(-2)}`;
	}

	private hourLabel(hour: number): string {
		return `${String(new Date(hour).getHours()).padStart(2, "0")}:00`;
	}
	private requestId = 0;

	constructor() {
		super();
		this.bucket = 0;
		this.hours = [];
		this.report = null;
		this.error = "";
		this.loading = false;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		const timeline = readPayload()?.timeline ?? [];
		const x = timeline[0] ?? [];
		this.hours = x
			.map((seconds, i) => ({
				bucket: seconds * 1000,
				tokens: timeline
					.slice(1)
					.reduce((n, series) => n + (series[i] ?? 0), 0),
			}))
			.filter((p) => p.tokens > 0)
			.map((p) => p.bucket)
			.reverse();
		const requested = Number(new URLSearchParams(location.search).get("hour"));
		this.bucket = this.hours.includes(requested)
			? requested
			: (this.hours[0] ?? 0);
		if (this.bucket) this.refresh();
	}

	private refresh(): void {
		const requestId = ++this.requestId;
		const params = new URLSearchParams(location.search);
		params.set("bucket", String(this.bucket));
		params.delete("hour");
		this.loading = true;
		this.error = "";
		fetch(`/api/usage/hour?${params.toString()}`, {
			signal: AbortSignal.timeout(15_000),
		})
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
				return r.json() as Promise<{ report: UsageReport }>;
			})
			.then((body) => {
				if (requestId !== this.requestId) return;
				this.report = body.report;
				this.loading = false;
			})
			.catch((e) => {
				if (requestId !== this.requestId) return;
				this.error = String((e as Error).message ?? e);
				this.loading = false;
			});
	}

	private selectHour(hour: number): void {
		this.bucket = hour;
		const url = new URL(location.href);
		url.searchParams.set("hour", String(hour));
		history.replaceState(null, "", url);
		this.refresh();
	}

	protected render(): TemplateResult {
		if (!this.hours.length) return html``;
		const days = [...new Set(this.hours.map((hour) => this.dayKey(hour)))];
		const selectedDay = this.dayKey(this.bucket);
		const dayHours = this.hours.filter(
			(hour) => this.dayKey(hour) === selectedDay,
		);
		const rows =
			this.report?.actors.flatMap((actor) =>
				actor.byModel.map((model) => ({ actor: actor.actor, ...model })),
			) ?? [];
		return html`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(e: Event) => {
						const day = (e.target as HTMLSelectElement).value;
						const hour = this.hours.find((h) => this.dayKey(h) === day);
						if (hour !== undefined) this.selectHour(hour);
					}}
				>
					${days.map((day) => html`<option value=${day} ?selected=${day === selectedDay}>${this.dayLabel(day)}</option>`)}
				</select>
			</label>
			<label class="hour-picker">hour
				<select
					@change=${(e: Event) => this.selectHour(Number((e.target as HTMLSelectElement).value))}
					title=${new Date(this.bucket).toISOString()}
				>
					${dayHours.map((hour) => html`<option value=${String(hour)} ?selected=${hour === this.bucket} title=${new Date(hour).toISOString()}>${this.hourLabel(hour)}</option>`)}
				</select>
			</label>
			${this.loading ? html`<p class="uempty">Loading hour…</p>` : nothing}
			${this.error ? html`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>` : nothing}
			${!this.loading && !this.error && rows.length === 0 ? html`<p class="uempty">No attributed usage in this hour.</p>` : nothing}
			${
				!this.loading && !this.error && rows.length > 0
					? html`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${rows.map((row) => html`<tr><td>${row.actor}</td><td>${row.model}</td><td>${row.group}</td><td>${fmtTok(row.i)}</td><td>${fmtTok(row.cr)}</td><td>${fmtTok(row.cc)}</td><td>${fmtTok(row.o)}</td><td>${String(row.rq)}</td></tr>`)}</tbody>
			</table></div>`
					: nothing
			}
		</div>`;
	}
}

KlhUsageDrilldown.styles = [
	panelCss,
	css`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`,
];

// ─── <klh-usage-charts> — the uPlot panels (timeline + hour histogram) ─────
// Light DOM by exception: uPlot builds its own canvas DOM inside the mount
// divs and the document-level uPlot chrome CSS must reach it —
// createRenderRoot returns the element itself. Absorbs the retired
// bin/usage-charts.ts: one host, no inline render script on the page.
// Titles ride the tl/hours attributes (the fed page passes its own).
interface UPlotChart {
	width: number;
	redraw(resetScales: boolean, recreate: boolean): void;
	setSize(size: { width: number; height: number }): void;
}
interface UPlotCtor {
	new (
		opts: Record<string, unknown>,
		data: unknown[][],
		target: HTMLElement,
	): UPlotChart;
	paths?: { bars(opts: { size: [number, number] }): unknown };
}

export class KlhUsageCharts extends LitElement {
	static properties = {
		tl: { type: String },
		hours: { type: String },
	};

	declare tl: string;
	declare hours: string;
	private slot: Record<string, string> = {};
	private groups: string[] = [];
	private timeline: number[][] = [];
	private byHour: number[][] = [];
	private charts: UPlotChart[] = [];
	private ros: ResizeObserver[] = [];
	private resizes: (() => void)[] = [];
	private onTheme: (() => void) | null = null;

	constructor() {
		super();
		this.tl = "TOKENS · STACKED BY MODEL GROUP";
		this.hours = "WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)";
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.tl = this.getAttribute("tl") ?? this.tl;
		this.hours = this.getAttribute("hours") ?? this.hours;
		const root = readPayload();
		this.slot = root?.slot ?? {};
		this.groups = root?.groups ?? [];
		this.timeline = root?.timeline ?? [];
		this.byHour = root?.byHour ?? [];
		if (this.onTheme === null) {
			this.onTheme = () => {
				for (const c of this.charts) c.redraw(false, true);
			};
			document.addEventListener("klh-themechange", this.onTheme);
		}
	}

	protected disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const ro of this.ros) ro.disconnect();
		this.ros = [];
		for (const fn of this.resizes) window.removeEventListener("resize", fn);
		this.resizes = [];
		if (this.onTheme !== null) {
			document.removeEventListener("klh-themechange", this.onTheme);
			this.onTheme = null;
		}
	}

	// uPlot paints into the light-DOM mount divs — see the block comment
	protected createRenderRoot(): HTMLElement {
		return this;
	}

	protected render(): TemplateResult {
		if (!this.timeline.length && !this.byHour.length) return html``;
		return html`<div class="usage-chart-grid"><div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map(
						(g) =>
							html`<span><i style=${`background:${slotColor(this.slot, g)}`}></i
								>${g}</span>`,
					)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div></div>`;
	}

	protected firstUpdated(): void {
		const uPlot = (globalThis as { uPlot?: UPlotCtor }).uPlot;
		if (!uPlot) return; // vendor inline absent — degrade honestly
		// chart chrome follows the klh theme tokens; uPlot calls the stroke fns
		// on every draw, so a klh-themechange only needs a redraw (W269)
		const tok = (name: string, dflt: string): string => {
			const v = getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim();
			return v || dflt;
		};
		const grid = (): string => tok("--klh-chart-grid", "#2c2c2a");
		const hair = (): string => tok("--klh-chart-hair", "#383835");
		const axis = (): string => tok("--klh-chart-axis", "#898781");
		const yVals = (_u: unknown, splits: number[]): string[] =>
			splits.map((v) => fmtTok(v));
		const mkAxis = (
			side: number,
			values?: (u: unknown, splits: number[]) => string[],
		): Record<string, unknown> => {
			const a: Record<string, unknown> = {
				side,
				// The default left gutter clips the leading digit at 100M+.
				...(side === 3 ? { size: 72 } : {}),
				stroke: axis,
				grid: { show: true, stroke: grid, width: 1 },
				ticks: { show: true, stroke: hair, width: 1 },
			};
			if (values) a.values = values;
			return a;
		};
		const tEl = this.querySelector<HTMLElement>("#u-timeline");
		if (tEl && this.groups.length) {
			// series order IS the fixed group order, so a group keeps its color
			// everywhere it appears on the page
			const series: Record<string, unknown>[] = [{}];
			for (const g of this.groups) {
				const c = slotColor(this.slot, g);
				series.push({
					label: g,
					stacked: true,
					stroke: c,
					fill: c,
					width: 1,
					points: { show: false },
					value: (_u: unknown, v: number | null): string => fmtChartValue(v),
				});
			}
			this.chart(
				tEl,
				uPlot,
				{
					width: tEl.clientWidth,
					height: 300,
					legend: { show: true, live: true },
					scales: { x: { time: true } },
					series,
					axes: [mkAxis(2), mkAxis(3, yVals)],
				},
				this.timeline,
				300,
			);
		}
		// hour-of-day histogram — single-series distribution, slot 1 (flash blue)
		const hEl = this.querySelector<HTMLElement>("#u-hours");
		if (hEl) {
			this.chart(
				hEl,
				uPlot,
				{
					width: hEl.clientWidth,
					height: 190,
					legend: { show: false },
					scales: { x: { time: false } },
					series: [
						{},
						{
							label: "tokens",
							stroke: slotColor(this.slot, "flash"),
							fill: slotColor(this.slot, "flash"),
							paths: uPlot.paths?.bars({ size: [0.72, 100] }),
							points: { show: false },
							value: (_u: unknown, v: number | null): string =>
								fmtChartValue(v),
						},
					],
					axes: [
						mkAxis(2, (_u, splits) =>
							splits.map((v) => String(Math.round(v)).padStart(2, "0")),
						),
						mkAxis(3, yVals),
					],
				},
				this.byHour,
				190,
			);
		}
	}

	private chart(
		el: HTMLElement,
		uPlot: UPlotCtor,
		opts: Record<string, unknown>,
		data: unknown[][],
		height: number,
	): void {
		const u = new uPlot(opts, data, el);
		this.charts.push(u);
		const fit = (): void => {
			const w = el.clientWidth;
			if (w > 0 && w !== u.width) u.setSize({ width: w, height });
		};
		if (typeof ResizeObserver === "function") {
			const ro = new ResizeObserver(fit);
			ro.observe(el);
			this.ros.push(ro);
		} else {
			this.resizes.push(fit);
			window.addEventListener("resize", fit);
		}
	}
}

KlhUsageCharts.styles = css`
	:host {
		display: block;
	}
`;

customElements.define("klh-usage-header", KlhUsageHeader);
customElements.define("klh-usage-tiles", KlhUsageTiles);
customElements.define("klh-usage-actors", KlhUsageActors);
customElements.define("klh-usage-aids", KlhUsageAids);
customElements.define("klh-usage-activity", KlhUsageActivity);
customElements.define("klh-usage-spokes", KlhUsageSpokes);
customElements.define("klh-usage-crosshub", KlhUsageCrossHub);
customElements.define("klh-usage-drilldown", KlhUsageDrilldown);
customElements.define("klh-usage-charts", KlhUsageCharts);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-header": KlhUsageHeader;
		"klh-usage-tiles": KlhUsageTiles;
		"klh-usage-actors": KlhUsageActors;
		"klh-usage-aids": KlhUsageAids;
		"klh-usage-activity": KlhUsageActivity;
		"klh-usage-spokes": KlhUsageSpokes;
		"klh-usage-crosshub": KlhUsageCrossHub;
		"klh-usage-drilldown": KlhUsageDrilldown;
		"klh-usage-charts": KlhUsageCharts;
	}
}
