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
import {
	LitElement,
	css,
	html,
	nothing,
	type CSSResultGroup,
	type TemplateResult,
} from "lit";
import type {
	UsageActivityCell,
	UsageActivityLane,
	UsageActivityWeek,
	UsageActorRow,
	UsageAidsPanel,
	UsagePanels,
	UsageSeg,
} from "../bin/usage-chrome.ts";

// ─── shared payload read ──────────────────────────────────────────────────
interface PanelRoot {
	slot: Record<string, string>;
	panels?: UsagePanels;
}
const readPanels = (): UsagePanels | null => {
	const el = document.getElementById("usage-data");
	if (!el) return null;
	try {
		const root = JSON.parse(el.textContent ?? "") as Partial<PanelRoot>;
		return root.panels ?? null;
	} catch {
		return null;
	}
};
const readSlot = (): Record<string, string> => {
	const el = document.getElementById("usage-data");
	if (!el) return {};
	try {
		const root = JSON.parse(el.textContent ?? "") as Partial<PanelRoot>;
		return root.slot ?? {};
	} catch {
		return {};
	}
};

// ─── client-side formatting (payload carries honest numbers) ──────────────
const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

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
	static properties = { rows: { type: Array, state: true } };

	declare rows: UsageActorRow[];
	private slot: Record<string, string> = {};

	constructor() {
		super();
		this.rows = [];
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.rows = readPanels()?.actors?.rows ?? [];
		this.slot = readSlot();
	}

	protected render(): TemplateResult {
		const p = readPanels()?.actors;
		if (!p?.rows.length) return html``;
		return this.body(p.rows);
	}

	private body(rows: UsageActorRow[]): TemplateResult {
		return html`<div class="upanel">
			<h2>ACTORS</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
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
				<h2>ACTIVITY · DECANT SHAPE (W243)</h2>
				<p class="uempty">${p.empty}</p>
			</div>`;
		return this.body(p);
	}

	private body(
		p: Exclude<NonNullable<UsagePanels["activity"]>, { empty: string }>,
	): TemplateResult {
		return html`<div class="upanel">
			<div class="uhead">
				<h2>ACTIVITY · DECANT SHAPE (W243)</h2>
				<p class="ufoot">${p.foot}</p>
			</div>
			${this.weekly(p.weekly)}
			${this.lanes(p.lanes)}
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

customElements.define("klh-usage-tiles", KlhUsageTiles);
customElements.define("klh-usage-actors", KlhUsageActors);
customElements.define("klh-usage-aids", KlhUsageAids);
customElements.define("klh-usage-activity", KlhUsageActivity);
customElements.define("klh-usage-spokes", KlhUsageSpokes);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-tiles": KlhUsageTiles;
		"klh-usage-actors": KlhUsageActors;
		"klh-usage-aids": KlhUsageAids;
		"klh-usage-activity": KlhUsageActivity;
		"klh-usage-spokes": KlhUsageSpokes;
	}
}
