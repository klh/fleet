// <belt-topology-hubs> — the hub-first topology overview (W858.7.31, slice 2):
// aggregated hub cards, layer/time controls, search, selected-hub inspector
// with collapsed model inventory, camera-stable refresh and an accessible
// list. Rides the `belt-topology-data` event from <belt-topology>.
import {
	hubOverview,
	hubOverviewLayout,
} from "./dashboard-topology-hubs-model.js";
import { css, html, LitElement, svg } from "./vendor/lit.js";

const localTime = (value) => {
	const time = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(time)
		? new Date(time).toLocaleString("da-DK", {
				day: "2-digit",
				month: "2-digit",
				year: "2-digit",
				hour: "2-digit",
			 minute: "2-digit",
				hour12: false,
			})
		: "never observed";
};

const measure = (value) =>
	Number.isFinite(value) ? value.toLocaleString("en-US") : "unreported";

const age = (value) => {
	const elapsed = Date.now() - Date.parse(value);
	if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
	if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	return `${Math.floor(elapsed / 3_600_000)}h ago`;
};

const stateColour = (state) =>
	state === "active"
		? "var(--klh-ok-ink)"
		: state === "quiet"
			? "var(--klh-info)"
			: "var(--klh-dim)";

const windowLabel = (windowMs) => (windowMs === 60_000 ? "1m" : "15m");

class BeltTopologyHubs extends LitElement {
	static properties = {
		topology: { state: true },
		layer: { state: true },
		windowMs: { state: true },
		query: { state: true },
		selectedId: { state: true },
	};
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		.heading { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		h3 { font:inherit; font-size:var(--klh-text-sm); margin:var(--klh-space-3) 0 var(--klh-space-2); }
		p { color:var(--klh-dim); font-size:var(--klh-text-sm); margin:var(--klh-space-2) 0; }
		.controls { display:flex; align-items:center; gap:var(--klh-space-3); flex-wrap:wrap; margin:var(--klh-space-2) 0; }
		fieldset { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:2px 8px; margin:0; display:flex; gap:8px; align-items:center; }
		legend { font-size:var(--klh-text-xs); color:var(--klh-dim); padding-inline:4px; }
		label { font-size:var(--klh-text-sm); color:var(--klh-ink-2); display:flex; gap:4px; align-items:center; }
		input[type="search"] { min-inline-size:200px; max-inline-size:100%; background:var(--klh-surface); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:6px 8px; font:inherit; }
		input:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		button { background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:disabled { color:var(--klh-dim); cursor:not-allowed; opacity:.6; }
		.crumbs { font-size:var(--klh-text-sm); color:var(--klh-dim); display:flex; gap:6px; align-items:center; }
		.crumbs strong { color:var(--klh-ink); font-weight:600; }
		.metrics { display:flex; gap:var(--klh-space-2); flex-wrap:wrap; margin-block:var(--klh-space-3); }
		.metrics div { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:6px 10px; min-inline-size:112px; }
		.metrics strong { display:block; font-variant-numeric:tabular-nums; font-size:var(--klh-text-lg); }
		.metrics small { color:var(--klh-dim); font-size:var(--klh-text-xs); }
		.hubs-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(260px,320px); gap:var(--klh-space-3); }
		.hubs-map { block-size:360px; overflow:auto; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); background:var(--klh-surface); }
		.hubs-map svg { inline-size:var(--map-width); min-inline-size:100%; font-size:12px; }
		.hub-card { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1.5; }
		.hub-card.planned { stroke-dasharray:4 3; }
		.hub-card.selected { stroke:var(--klh-accent); stroke-width:2.5; }
		.hub-link { fill:none; stroke:var(--klh-info); stroke-width:1.5; }
		.hub-link.ledger { stroke:var(--klh-dim); stroke-dasharray:4 4; }
		.hub-link.selected { stroke:var(--klh-accent); stroke-width:3; }
		.hub-title { fill:var(--klh-ink); font-weight:600; pointer-events:none; }
		.hub-sub { fill:var(--klh-dim); font-size:10px; font-variant-numeric:tabular-nums; pointer-events:none; }
		.hub-dot { pointer-events:none; }
		.hit { fill:none; stroke:transparent; stroke-width:14; cursor:pointer; }
		.hub-item:focus-visible { outline:none; }
		.hub-item:focus-visible .hub-card { stroke:var(--klh-accent); stroke-width:3; }
		.inspector { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:var(--klh-space-2); block-size:360px; box-sizing:border-box; overflow:auto; }
		.inspector h3 { margin-block:0 var(--klh-space-2); }
		.inspector dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; font-size:var(--klh-text-sm); margin:0; }
		.inspector dt { color:var(--klh-dim); }
		.inspector dd { margin:0; overflow-wrap:anywhere; }
		.inspector details { margin-block:var(--klh-space-2); }
		.inspector summary { cursor:pointer; color:var(--klh-ink); }
		.trace-list { padding-inline-start:18px; font-size:var(--klh-text-xs); overflow-wrap:anywhere; }
		.results { display:grid; gap:2px; margin:0; }
		.results button { margin:0; text-align:start; padding:3px 8px; }
		.coverage { color:var(--klh-dim); font-size:var(--klh-text-xs); line-height:1.4; }
		table { border-collapse:collapse; inline-size:min(100%, 760px); margin-top:var(--klh-space-2); }
		th, td { text-align:start; padding:5px 12px 5px 0; border-block-end:1px solid var(--klh-edge-faint); font-size:var(--klh-text-sm); }
		details > summary { cursor:pointer; }
		@media (max-width:760px) { .hubs-layout { grid-template-columns:minmax(0,1fr); } .inspector { block-size:auto; min-block-size:150px; max-block-size:360px; } }
	`;
	constructor() {
		super();
		this.topology = null;
		this.layer = "observed";
		this.windowMs = 900_000;
		this.query = "";
		this.selectedId = null;
		this.onData = (event) => {
			this.topology = event.detail;
		};
	}
	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("belt-topology-data", this.onData);
		this.topology =
			document.querySelector("belt-topology")?.topology ?? this.topology;
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("belt-topology-data", this.onData);
	}
	onSearch(event) {
		this.query = event.target.value;
	}
	select(id) {
		this.selectedId = id;
	}
	onKey(event, id) {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		this.selectedId = id;
	}
	focusNode(id) {
		this.updateComplete.then(() => {
			this.renderRoot
				.querySelector(`[data-node="${id}"]`)
				?.scrollIntoView({ block: "nearest", inline: "nearest" });
		});
	}
	hubModelsFor() {
		const models = {};
		for (const hub of this.topology?.hubs ?? []) {
			const merged = [...(hub.gatewayModels ?? []), ...(hub.beltModels ?? [])];
			if (merged.length) models[hub.name] = merged;
		}
		return models;
	}
	configuredHubsFor(data) {
		return (data?.hubs ?? []).map((hub) => ({
			name: hub.name,
			state: hub.state,
		}));
	}
	windowComplete(graph, windowMs) {
		if (!graph) return false;
		return windowMs <= 60_000 || graph.totals.requests !== null;
	}
	inspector(view, graph) {
		const selected = view.hubs.find((hub) => hub.id === this.selectedId);
		if (!selected) {
			return html`<h3>Inspect a hub</h3>
				<p>${this.selectedId ? "The selected hub left the chosen window or layer." : "Select a hub card or a list row. The drawer keeps state, traffic and the collapsed model inventory."}</p>`;
		}
		return this.inspectorDetail(selected, graph);
	}
	inspectorDetail(selected, graph) {
		const traces = graph.traces
			.filter((trace) => trace.hops.includes(selected.label))
			.slice(0, 5);
		const models = this.hubModelsFor()[selected.label] ?? [];
		const tokenNote =
			selected.tokens.input === null && selected.tokens.output === null
				? "unreported"
				: `${measure(selected.tokens.input)} / ${measure(selected.tokens.output)} · ${measure(selected.tokens.usageBearing)} requests with token usage`;
		return html`<h3>${selected.label}</h3>
			<dl>
				<dt>State</dt><dd>${selected.state}${selected.observed ? "" : " · planning layer"}</dd>
				<dt>Last observed</dt><dd>${localTime(selected.lastSeenAt)} · ${age(selected.lastSeenAt)}</dd>
				<dt>Observed hops</dt><dd>${measure(selected.requests)} in ${windowLabel(this.windowMs)}</dd>
				<dt>Failed hops</dt><dd>${measure(selected.failed)}</dd>
				<dt>Active requests</dt><dd>${measure(selected.active)}</dd>
				<dt>Input / output tokens</dt><dd>${tokenNote}</dd>
			</dl>
			<details>
				<summary>Observed endpoints · ${selected.endpoints.length}</summary>
				${selected.endpoints.length
					? html`<ul class="trace-list">${selected.endpoints.map(
							(item) =>
								html`<li>${item.label} · ${measure(item.requests)} hops · ${age(item.lastSeenAt)}</li>`,
						)}</ul>`
					: html`<p>No endpoint traffic in this window.</p>`}
			</details>
			<details>
				<summary>Model inventory · ${models.length}</summary>
				${models.length
					? html`<ul class="trace-list">${models.map(
							(model) => html`<li>${model}</li>`,
						)}</ul>`
					: html`<p>No configured or Belt-served models reported.</p>`}
			</details>
			<h3>Joined traces</h3>
			${traces.length
				? html`<ol class="trace-list">${traces.map(
						(trace) =>
							html`<li><code>${trace.id.slice(0, 12)}…</code> · ${trace.hops.join(" → ")} · ${trace.complete ? "complete" : "partial"}</li>`,
					)}</ol>`
				: html`<p>No joined trace for this hub.</p>`}
		`;
	}

	renderMap(view, layout) {
		const positions = new Map(layout.nodes.map((node) => [node.id, node]));
		return svg`<svg viewBox=${`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Aggregated hub cards. Tab to a hub and press Enter to inspect it.">
			${view.links.map((link) => {
				const from = positions.get(link.from);
				const to = positions.get(link.to);
				if (!from || !to) return svg``;
				const path = `M${from.x + 190} ${from.y + 32} L${to.x} ${to.y + 32}`;
				return svg`<g class="hub-item" role="button" tabindex="0" data-node=${link.id} aria-label=${`${link.from} to ${link.to}, ${link.requests} hops, ${link.evidence} evidence`} @click=${() => this.select(link.id)} @keydown=${(event) => this.onKey(event, link.id)}>
					<path class=${`hub-link ${link.evidence === "ledger" ? "ledger" : ""} ${this.selectedId === link.id ? "selected" : ""}`} d=${path}></path>
					<path class="hit" d=${path}></path>
				</g>`;
			})}
			${layout.nodes.map(
				(node) => svg`<g class="hub-item" role="button" tabindex="0" data-node=${node.id} aria-label=${`${node.label}, ${node.state}, ${node.requests} hops and ${node.failed} failures in the selected window, ${node.endpoints.length} observed endpoints`} @click=${() => this.select(node.id)} @keydown=${(event) => this.onKey(event, node.id)}>
					<rect class=${`hub-card ${node.state === "planned" ? "planned" : ""} ${this.selectedId === node.id ? "selected" : ""}`} x=${node.x} y=${node.y} width="190" height="64" rx="4"></rect>
					<circle class="hub-dot" cx=${node.x + 14} cy=${node.y + 17} r="3.5" fill=${stateColour(node.state)}></circle>
					<text class="hub-title" x=${node.x + 24} y=${node.y + 21}>${node.label.length > 21 ? `${node.label.slice(0, 20)}…` : node.label}</text>
					<text class="hub-sub" x=${node.x + 12} y=${node.y + 38}>${measure(node.requests)} hops · ${measure(node.failed)} failed</text>
					<text class="hub-sub" x=${node.x + 12} y=${node.y + 53}>${node.endpoints.length} endpoints · ${node.downstream.size} hubs · ${node.state}</text>
				</g>`,
			)}
		</svg>`;
	}


	render() {
		const data = this.topology;
		if (!data) {
			return html`<section>
				<h2>Hub topology</h2>
				<p>Waiting for the first topology snapshot…</p>
			</section>`;
		}
		const graph = data.observedGraph ?? null;
		if (!graph) {
			return html`<section>
				<h2>Hub topology</h2>
				<p>The topology read model returned no observed graph — navigation opens once the first measured path lands.</p>
			</section>`;
		}
		const view = hubOverview(graph, {
			layer: this.layer,
			windowMs: this.windowMs,
			query: this.query,
			hubModels: this.hubModelsFor(),
			configuredHubs: this.configuredHubsFor(data),
			now: Date.now(),
		});
		const layout = hubOverviewLayout(view.hubs, view.links);
		const selected = view.hubs.find((hub) => hub.id === this.selectedId) ?? null;
		return html`<section>
			<h2>Hub topology · ${this.layer} layer</h2>
			<p role="status">${view.hubs.length} hubs · ${view.links.length} hub links · snapshot updated ${age(view.observedAt)}</p>
			<div class="controls">
				<fieldset>
					<legend>Layer radios: observed, connected, configured</legend>
					${["observed", "connected", "configured"].map(
						(name) => html`<label><input type="radio" name="layer" .checked=${this.layer === name} @change=${() => { this.layer = name; }} />${name}</label>`,
					)}
				</fieldset>
				<fieldset>
					<legend>Window radios: 1m, 15m live; 1h, 24h disabled</legend>
					<label><input type="radio" name="window" .checked=${this.windowMs === 60_000} @change=${() => { this.windowMs = 60_000; }} />1m</label>
					<label><input type="radio" name="window" .checked=${this.windowMs === 1000 * 900} @change=${() => { this.windowMs = 900_000; }} />15m</label>
					<label><input type="radio" name="window" disabled title="The snapshot covers a 15m window — longer windows stay disabled rather than guess." />1h</label>
					<label><input type="radio" name="window" disabled title="The snapshot covers a 15m window — longer windows stay disabled rather than guess." />24h</label>
				</fieldset>
				<label class="search">Search
					<input type="search" .value=${this.query} placeholder="hub or model name" @input=${(event) => this.onSearch(event)} />
				</label>
			</div>
			${view.search.length
				? html`<div class="results">Search hits: ${view.search.map(
						(hit) => html`<button type="button" @click=${() => { this.select(hit.id); this.focusNode(hit.id); }}>${hit.label}${hit.kind === "model" ? ` via ${hit.via}` : ""}</button>`,
					)}</div>`
				: ""}
			<p class="crumbs">Estate${selected ? ` › ${selected.label}` : ""}${this.selectedId ? html` <button type="button" @click=${() => this.select("")}>Back to estate</button> ` : ""}</p>
			<div class="metrics" role="status">
				<div><strong>${measure(view.estate.hubs)}</strong><small>hubs in view</small></div>
				<div><strong>${measure(view.estate.endpoints)}</strong><small>observed endpoints</small></div>
				<div><strong>${measure(view.estate.requests)}</strong><small>hops · ${windowLabel(this.windowMs)}</small></div>
				<div><strong>${measure(view.estate.failed)}</strong><small>failed · ${windowLabel(this.windowMs)}</small></div>
			</div>
			<div class="hubs-layout">
				<div class="hubs-map" style=${`--map-width:${layout.width}px`}>${this.renderMap(view, layout)}</div>
				<aside class="inspector">${this.inspector(view, graph)}</aside>
			</div>
			<h3>Hubs</h3>
			<table class="hub-list">
				<caption class="skip">All hubs with inspect buttons</caption>
				<tbody>
					${view.hubs.map(
						(hub) => html`<tr><td>${hub.label}</td><td>${hub.state}</td><td>${measure(hub.requests)} hops</td><td><button type="button" @click=${() => this.select(hub.id)}>Inspect ${hub.label}</button></td></tr>`,
					)}
				</tbody>
			</table>
			<h3>Hub links</h3>
			<table class="link-list">
				<caption class="skip">All hub links with inspect buttons</caption>
				<tbody>
					${view.links.map(
						(link) => html`<tr><td>${link.from.replace("hub:", "")}</td><td>${link.to.replace("hub:", "")}</td><td>${measure(link.requests)} hops · ${link.evidence}</td><td><button type="button" @click=${() => this.select(link.id)}>Inspect link</button></td></tr>`,
					)}
				</tbody>
			</table>
			<p class="coverage">Snapshot window ${windowLabel(this.windowMs)} · projection ${graph.coverage?.projectionAvailable ? "available" : "unavailable"} · ledger ${graph.coverage?.ledgerAvailable ? "available" : "unavailable"} · ${measure(graph.coverage?.tracesReturned)} of ${measure(graph.coverage?.tracesTotal)} traces returned.</p>
		</section>`;
	}

}

customElements.define("belt-topology-hubs", BeltTopologyHubs);
