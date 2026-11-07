// dashboard-fleet.js — W2269.1.2: the unified fleet table as a Lit element
// (retired from the string-PAGE renderFleet()/mount() renderer in
// dashboard.ts). Same columns, same disclosure rows, same open-row
// persistence across 3s polls; the shared .fhead/.frow grid CSS stays in the
// host page (light DOM) exactly as before — this element owns its DOM
// through Lit but wears the page's classes, so the visual contract and the
// byte-stable row text are unchanged.
import { html, LitElement } from "./vendor/lit.js";
import { defineElement } from "./register.js";

const short = (m) => String(m || "").replace("mlx-community/", "");
const age = (iso, now) => {
	if (!iso) return "—";
	var t = Math.max(0, (now - Date.parse(iso)) / 1000);
	if (t < 3600) return `${Math.max(1, Math.round(t / 60))}m`;
	if (t < 86400) return `${Math.round(t / 3600)}h`;
	return `${Math.round(t / 86400)}d`;
};

class BeltFleetTable extends LitElement {
	// light DOM: the page's .fhead/.frow/.panel grid CSS and the token scale
	// already live in the dashboard <style> block — shadow DOM would orphan
	// them, so this element renders into itself without a shadow root.
	createRenderRoot() {
		return this;
	}

	static properties = {
		status: { state: true },
		localName: { state: true },
		remoteRows: { state: true },
	};

	constructor() {
		super();
		this.status = null;
		this.localName = "";
		this.remoteRows = [];
		this._openRows = {};
		this._boundToggle = this._rememberToggle.bind(this);
	}

	connectedCallback() {
		super.connectedCallback();
		this.addEventListener("toggle", this._boundToggle, true);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		this.removeEventListener("toggle", this._boundToggle, true);
	}

	// disclosure state survives the 3s re-render: the open set is keyed by
	// data-key, exactly like the retired openRows record.
	_rememberToggle(event) {
		const details = event.target;
		if (details?.tagName !== "DETAILS") return;
		const key = details.getAttribute("data-key");
		if (!key) return;
		if (details.open) this._openRows[key] = 1;
		else delete this._openRows[key];
	}

	_row(x, now) {
		const state = html`<span class="${x.up ? "ok" : "mut"}"
			>${x.state_label || "unknown"}</span
		>`;
		const load =
			(x.load_5m || 0) > 0 ? html`<em class="load">${x.load_5m}/5m</em>` : "";
		const modelFull = x.model_served || x.model || "";
		const mem =
			x.up && x.ram_gb != null
				? html`<div class="mrow">
						<span>${short(modelFull)}</span>
						<span class="n">${x.ram_gb} GB</span>
					</div>
					<div class="bar">
						<i style="width:${(x.ram_gb / 128) * 100}%"></i>
					</div>`
				: "";
		const bits = [
			`engine ${x.engine || "—"}`,
			...(x.tier ? [`tier ${x.tier}`] : []),
			...(x.ram_gb != null ? [`${x.ram_gb} GB ram`] : []),
			`last used ${x.last_used ? age(x.last_used, now) : "—"}`,
			`${x.calls || 0} calls`,
			`avg ${x.avg_ms != null ? `${x.avg_ms}ms` : "—"}`,
			`${x.errors || 0} errors`,
		];
		if (x.last_error)
			bits.push(html`<span class="mut">last error: ${x.last_error}</span>`);
		const key = `L${x.port}`;
		return html`<details
			class="frow"
			data-key=${key}
			?open=${Boolean(this._openRows[key])}
		>
			<summary>
				<span>${this.localName} <span class="u">(local)</span></span>
				<span>:${x.port}</span>
				<span class="cstate">${state}${load}</span>
				<span
					><span class="badge ${x.protocol || ""}"
						>${x.protocol || "—"}</span
					></span
				>
				<span class="cmodel" title=${modelFull}
					>${short(modelFull) || "—"}</span
				>
				<span class="w">${x.engine || "—"}</span>
				<span class="w">${x.ram_gb != null ? `${x.ram_gb} GB` : "—"}</span>
				<span class="w">${x.avg_ms != null ? `${x.avg_ms}ms` : "—"}</span>
				<span class="w cgood">${x.good_at || "—"}</span>
			</summary>
			<div class="panel">
				<p>
					<span class="mut">good at:</span> ${x.good_at || "—"}
				</p>
				${mem}
				<p class="mut">${bits.map((bit, i) => html`${i > 0 ? " · " : ""}${bit}`)}</p>
			</div>
		</details>`;
	}

	render() {
		if (!this.status) return html``;
		const now = Date.parse(this.status.ts);
		const router = { engine: "bun", ram_gb: null, ...this.status.router };
		const rows = [router, ...this.status.specialists];
		return html`${rows.map((x) => this._row(x, now))}`;
	}
}

defineElement("belt-fleet-table", BeltFleetTable);
