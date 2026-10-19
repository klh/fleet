// hooks/board-html/klh-usage-drilldown.ts — W826: the cache-efficiency
// drilldown as progressive disclosure: fleet warm-rate → per-lane rows
// (sortable, filtered) → a lane's request rows on expand. Fetches
// /api/usage/drilldown (server owns filters/sort/caps; fail-soft
// available:false renders the miss honestly). Lit + shadow DOM + --klh-*
// tokens, lit-html templates only (no banned DOM-injection APIs). Bundled
// with usage-panels.js via the side-effect import there — no extra vendor
// entry or page script.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

interface BustReason {
	reason: string;
	count: number;
}
interface LaneDrill {
	lane: string;
	requests: number;
	warm: number;
	warmRate: number;
	cacheR: number;
	cacheC: number;
	tokens: number;
	costIndex: number;
	reasons: BustReason[];
}
interface DrillReport {
	available: boolean;
	window: { from: string; to: string; days: number };
	fleet: {
		requests: number;
		warm: number;
		warmRate: number;
		tokens: number;
		costIndex: number;
	};
	lanes: LaneDrill[];
	models: string[];
}
interface DrillRow {
	rid: string;
	ts: string;
	model: string;
	status: number;
	ok: number;
	durationMs: number;
	cacheR: number;
	cacheC: number;
	decision: string;
	err: string | null;
}
interface DrillPage {
	available: boolean;
	lane: string;
	rows: DrillRow[];
	total: number;
	truncated: boolean;
	reasons: BustReason[];
}

const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const SORTS: Array<{ v: string; label: string }> = [
	{ v: "warm-rate", label: "warm rate (worst first)" },
	{ v: "cache-miss", label: "cache-miss ratio" },
	{ v: "tokens", label: "tokens" },
	{ v: "cost", label: "cost index" },
	{ v: "requests", label: "requests" },
];

export class KlhUsageDrilldown extends LitElement {
	static properties = {
		rep: { type: Object, state: true },
		page: { type: Object, state: true },
		drill: { type: String, state: true },
		days: { type: Number, state: true },
		model: { type: String, state: true },
		sort: { type: String, state: true },
		missOnly: { type: Boolean, state: true },
		err: { type: String, state: true },
	};

	declare rep: DrillReport | null;
	declare page: DrillPage | null;
	declare drill: string;
	declare days: number;
	declare model: string;
	declare sort: string;
	declare missOnly: boolean;
	declare err: string;

	constructor() {
		super();
		this.rep = null;
		this.page = null;
		this.drill = "";
		this.days = 7;
		this.model = "";
		this.sort = "warm-rate";
		this.missOnly = false;
		this.err = "";
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		void this.load();
	}

	private async load(): Promise<void> {
		const q = new URLSearchParams({
			days: String(this.days),
			sort: this.sort,
		});
		if (this.model !== "") q.set("model", this.model);
		try {
			const r = await fetch(`/api/usage/drilldown?${q}`);
			const j = (await r.json()) as { report?: DrillReport };
			this.rep = j.report ?? null;
			this.err =
				this.rep?.available === false
					? "no readable buckle ledger — drilldown unavailable"
					: "";
		} catch {
			this.err = "drilldown fetch failed";
			this.rep = null;
		}
	}

	private async open(lane: string): Promise<void> {
		if (this.drill === lane) {
			this.drill = "";
			this.page = null;
			return;
		}
		this.drill = lane;
		this.page = null;
		const q = new URLSearchParams({ drill: lane, days: String(this.days) });
		if (this.model !== "") q.set("model", this.model);
		if (this.missOnly) q.set("missOnly", "1");
		try {
			const r = await fetch(`/api/usage/drilldown?${q}`);
			const j = (await r.json()) as { page?: DrillPage };
			this.page = j.page ?? null;
		} catch {
			this.page = {
				available: false,
				lane,
				rows: [],
				total: 0,
				truncated: false,
				reasons: [],
			};
		}
	}

	private setFilter(
		f: Partial<{
			days: number;
			model: string;
			sort: string;
			missOnly: boolean;
		}>,
	): void {
		Object.assign(this, f);
		void this.load();
		if (this.drill !== "") {
			const lane = this.drill;
			this.drill = "";
			void this.open(lane);
		}
	}

	protected render(): TemplateResult | typeof nothing {
		if (this.rep === null)
			return html`<div class="upanel"><p class="uempty">${this.err === "" ? "loading…" : this.err}</p></div>`;
		return html`<div class="upanel">
			<h2>CACHE EFFICIENCY · ${this.rep.window.days}D</h2>
			${this.controls()}
			${this.fleetLine()}
			<table class="udrill">
				<thead>
					<tr>
						<th>lane</th>
						<th class="unum">reqs</th>
						<th class="unum">warm</th>
						<th class="unum">warm%</th>
						<th class="unum">cache rd</th>
						<th class="unum">cache wr</th>
						<th class="unum">tokens</th>
						<th class="unum">cost idx</th>
						<th>why cold</th>
					</tr>
				</thead>
				<tbody>
					${this.rep.lanes.map((l) => this.laneRow(l))}
				</tbody>
			</table>
		</div>`;
	}

	private controls(): TemplateResult {
		return html`<div class="uctl">
			<label>window
				<select @change=${(e: Event) => this.setFilter({ days: Number((e.target as HTMLSelectElement).value) })}>
					${[1, 7, 30, 90].map(
						(d) =>
							html`<option value=${d} ?selected=${this.days === d}>${d}d</option>`,
					)}
				</select>
			</label>
			<label>model
				<select @change=${(e: Event) => this.setFilter({ model: (e.target as HTMLSelectElement).value })}>
					<option value="" ?selected=${this.model === ""}>all</option>
					${(this.rep?.models ?? []).map(
						(m) =>
							html`<option value=${m} ?selected=${this.model === m}>${m}</option>`,
					)}
				</select>
			</label>
			<label>sort
				<select @change=${(e: Event) => this.setFilter({ sort: (e.target as HTMLSelectElement).value })}>
					${SORTS.map(
						(s) =>
							html`<option value=${s.v} ?selected=${this.sort === s.v}>${s.label}</option>`,
					)}
				</select>
			</label>
			<label class="uchk">
				<input type="checkbox" ?checked=${this.missOnly} @change=${(e: Event) => this.setFilter({ missOnly: (e.target as HTMLInputElement).checked })} />
				requests: cache-miss only
			</label>
		</div>`;
	}

	private fleetLine(): TemplateResult {
		const f = this.rep?.fleet;
		if (!f) return nothing;
		return html`<p class="ufleet">
			fleet warm-rate <b>${pct(f.warmRate)}</b> · ${fmtTok(f.requests)} requests warmed ${fmtTok(f.warm)} ·
			${fmtTok(f.tokens)} tokens · cost idx ${fmtTok(Math.round(f.costIndex))}
		</p>`;
	}

	private laneRow(l: LaneDrill): TemplateResult {
		const open = this.drill === l.lane;
		return html`<tr class=${open ? "open" : ""} @click=${() => void this.open(l.lane)}>
			<td class="ulane">${open ? "▾" : "▸"} ${l.lane === "" ? "(unlaned)" : l.lane}</td>
			<td class="unum">${fmtTok(l.requests)}</td>
			<td class="unum">${fmtTok(l.warm)}</td>
			<td class="unum ${l.warmRate < 0.25 ? "bad" : l.warmRate >= 0.6 ? "good" : ""}">${pct(l.warmRate)}</td>
			<td class="unum">${fmtTok(l.cacheR)}</td>
			<td class="unum">${fmtTok(l.cacheC)}</td>
			<td class="unum">${fmtTok(l.tokens)}</td>
			<td class="unum">${fmtTok(Math.round(l.costIndex))}</td>
			<td class="uwhy">${l.reasons.slice(0, 3).map((r) => html`<span class="uwhy-r">${r.reason}×${r.count}</span>`)}</td>
		</tr>
		${open && this.page !== null ? this.drillRow() : nothing}`;
	}

	private drillRow(): TemplateResult {
		return html`<tr class="usub">
			<td colspan="9">
				${
					this.page === null
						? html`<p class="uempty">loading ${this.drill}…</p>`
						: html`<p class="ufoot">
							${fmtTok(this.page.total)} requests${this.page.truncated ? " (capped — raise ?limit)" : ""} ·
							${this.page.reasons.slice(0, 3).map((r) => html`<span class="uwhy-r">${r.reason}×${r.count}</span>`)}
						</p>
						<table class="ureq">
							<thead>
								<tr><th>ts</th><th>model</th><th class="unum">status</th><th class="unum">ms</th><th class="unum">cache rd</th><th class="unum">cache wr</th><th>decision</th></tr>
							</thead>
							<tbody>
								${this.page.rows.map(
									(r) => html`<tr>
										<td class="uts">${r.ts.replace("T", " ").slice(0, 19)}</td>
										<td>${r.model}</td>
										<td class="unum ${r.ok ? "" : "bad"}">${r.status}</td>
										<td class="unum">${fmtTok(r.durationMs)}</td>
										<td class="unum">${fmtTok(r.cacheR)}</td>
										<td class="unum">${fmtTok(r.cacheC)}</td>
										<td class="udec" title=${r.err ?? ""}>${r.decision}</td>
									</tr>`,
								)}
							</tbody>
						</table>`
				}
			</td>
		</tr>`;
	}
}

KlhUsageDrilldown.styles = css`
	:host {
		display: block;
	}
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
	.uempty,
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	.uctl {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
		margin: 8px 0 10px;
		font-size: 11px;
		color: var(--klh-dim, #98958e);
	}
	.uctl select {
		background: var(--klh-bg, #141311);
		color: var(--klh-ink, #e8e6e1);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		font: inherit;
		padding: 1px 4px;
	}
	.ufleet {
		font-size: 11.5px;
		color: var(--klh-ink, #e8e6e1);
		margin: 0 0 8px;
	}
	.ufleet b {
		color: var(--klh-accent, #e0a458);
	}
	table.udrill,
	table.ureq {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.udrill th,
	table.udrill td,
	table.ureq th,
	table.ureq td {
		padding: 5px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	th {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--klh-dim, #98958e);
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.bad {
		color: var(--klh-bad, #c25b4e);
	}
	.good {
		color: var(--klh-good, #7ba05b);
	}
	tr[data-open] td,
	tbody tr {
		cursor: pointer;
	}
	tbody tr.usub,
	tbody tr.usub td {
		cursor: default;
	}
	.usub > td {
		background: var(--klh-bg, #141311);
	}
	.ulane {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.uwhy-r {
		display: inline-block;
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 2px;
		padding: 0 4px;
		margin: 0 3px 2px 0;
		white-space: nowrap;
	}
	.uts,
	.udec {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.udec {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
`;

customElements.define("klh-usage-drilldown", KlhUsageDrilldown);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-drilldown": KlhUsageDrilldown;
	}
}
