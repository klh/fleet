// dashboard-occupancy.js — W2618 per-hub utilization cards on the belt
// dashboard (:7791). Fetches /api/occupancy (the occupancy-face aggregate)
// and renders one card per model per hub: current vs max (progress bar +
// n/N + %), per-user rows underneath, and the hub total gauge vs the
// tree-derived total. Sparkline-friendly: the report carries a bounded
// sample ring. Degrades honestly — an unreachable hub renders its note.
import { html, css, LitElement } from "./vendor/lit.js";

const pctLabel = (current, max) =>
	max == null ? `${current} (no cap)` : `${current}/${max}`;

class BeltOccupancy extends LitElement {
	static properties = {
		rows: { state: true },
		error: { state: true },
	};
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		p { margin:var(--klh-space-2) 0; color:var(--klh-dim); font-size:var(--klh-text-sm); }
		.hub { margin-block:var(--klh-space-3); }
		.hubhead { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		.hubhead .total { margin-inline-start:auto; color:var(--klh-dim); font-size:var(--klh-text-sm); font-variant-numeric:tabular-nums; }
		.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:var(--klh-space-3); margin-block-start:var(--klh-space-2); }
		.card { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:var(--klh-space-2) var(--klh-space-3); }
		.card h3 { font:inherit; font-size:var(--klh-text-sm); margin:0; overflow-wrap:anywhere; }
		.bar { height:4px; background:var(--klh-edge-faint); border-radius:var(--klh-radius); margin-block:6px; overflow:hidden; }
		.bar i { display:block; height:100%; background:var(--klh-chart-axis); }
		.bar i.hot { background:var(--klh-accent); }
		.n { color:var(--klh-dim); font-size:var(--klh-text-sm); font-variant-numeric:tabular-nums; }
		.users { margin:6px 0 0; padding:0; list-style:none; font-size:var(--klh-text-sm); color:var(--klh-dim); }
		.note { color:var(--klh-dim); font-size:var(--klh-text-sm); }
	`;
	constructor() {
		super();
		this.rows = [];
		this.error = "";
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 15000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
	}
	async refresh() {
		try {
			const r = await fetch("/api/occupancy", {
				signal: AbortSignal.timeout(5000),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const j = await r.json();
			this.rows = Array.isArray(j.hubs) ? j.hubs : [];
			this.error = "";
		} catch (e) {
			this.error = String(e?.message ?? e);
		}
	}
	render() {
		if (this.error)
			return html`<h2>Hub utilization</h2><p class="note">occupancy: unreachable — ${this.error}</p>`;
		if (!this.rows.length)
			return html`<h2>Hub utilization</h2><p class="note">no hubs declared in hubs.json</p>`;
		return html`
			<h2>Hub utilization</h2>
			${this.rows.map((row) => this.renderHub(row))}
		`;
	}
	renderHub(row) {
		if (!row.report)
			return html`<div class="hub">
				<div class="hubhead"><h3>${row.hub}</h3><span class="note">${row.note}</span></div>
			</div>`;
		const t = row.report.totals;
		return html`<div class="hub">
			<div class="hubhead">
				<h3>${row.hub}</h3>
				<span class="total">
					hub total ${t.current}/${t.max == null ? "—" : t.max}
					(${row.report.derived_total} tree-derived · ${row.report.gauges.admitted_1m}/1m · ${row.report.gauges.admitted_5m}/5m)
				</span>
			</div>
			<div class="cards">
				${row.report.models.map((m) => this.renderCard(m))}
			</div>
		</div>`;
	}
	renderCard(m) {
		const w =
			m.max == null || m.max <= 0
				? 0
				: Math.min(100, (m.current / m.max) * 100);
		return html`<div class="card">
			<h3>${m.model}</h3>
			<div class="bar"><i class=${w >= 80 ? "hot" : ""} style="width:${w}%"></i></div>
			<span class="n">${pctLabel(m.current, m.max)}${m.pct == null ? "" : ` · ${m.pct}%`}</span>
			${
				m.users.length
					? html`<ul class="users">
					${m.users.map(
						(u) => html`<li>${u.user}: ${pctLabel(u.current, u.max)}</li>`,
					)}
				</ul>`
					: ""
			}
		</div>`;
	}
}
customElements.define("belt-occupancy", BeltOccupancy);
