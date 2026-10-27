// <belt-topology-hubs> — the hub-first topology overview (W858.7.31, slice 2):
// aggregated hub cards, layer/time controls, search, selected-hub inspector
// with collapsed model inventory, camera-stable refresh and an accessible
// list. Rides the `belt-topology-data` event from <belt-topology>.
import {
	hubOverview,
	hubOverviewLayout,
	parseTopologyHash,
	serializeTopologyHash,
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

// W902: UTC Z first + local twin beside it — hub clocks drift
const dualMinute = (value) => {
	const time = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(time)) return "never observed";
	const d = new Date(time);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z (${p(d.getHours())}:${p(d.getMinutes())})`;
};

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
		flowPaused: { state: true },
		team: { state: true },
		project: { state: true },
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
		.hub-link.failed { stroke:var(--klh-danger); }
		.hub-link.selected { stroke:var(--klh-accent); stroke-width:3; }
		.hub-link.flow { stroke-dasharray:5 9; animation:hub-flow var(--flow-duration,6s) linear infinite; }
		@keyframes hub-flow { from { stroke-dashoffset:0; } to { stroke-dashoffset:-56; } }
		.flow-paused .hub-link.flow { animation-play-state:paused; }
		@media (prefers-reduced-motion:reduce) { .hub-link.flow { animation:none; } }
		.legend { color:var(--klh-dim); font-size:var(--klh-text-xs); line-height:1.5; }
		.edge-chart { margin-block:var(--klh-space-2); min-height:80px; }
		.edge-chart:empty::after { content:"hop grid pending"; color:var(--klh-dim); font-size:var(--klh-text-xs); }
		.uplot, .uplot *, .uplot *::before, .uplot *::after { box-sizing:border-box; }
		.uplot { font:inherit; line-height:1.5; width:min-content; }
		.u-wrap { position:relative; user-select:none; }
		.u-over, .u-under { position:absolute; }
		.u-under { overflow:hidden; }
		.uplot canvas { display:block; position:relative; width:100%; height:100%; }
		.u-legend { font-size:11px; margin:auto; text-align:center; }
		.u-inline { display:block; }
		.u-inline * { display:inline-block; }
		.u-inline tr { margin-right:16px; }
		.u-legend th { font-weight:600; }
		.u-legend th > * { vertical-align:middle; display:inline-block; }
		.u-legend .u-marker { width:1em; height:1em; margin-right:4px; background-clip:padding-box; }
		.u-inline.u-live th::after { content:":"; vertical-align:middle; }
		.u-inline:not(.u-live) .u-value { display:none; }
		.u-series > * { padding:4px; }
		.u-cursor-x, .u-cursor-y { position:absolute; left:0; top:0; pointer-events:none; }
		.u-hz .u-cursor-x, .u-vt .u-cursor-y { height:100%; border-right:1px dashed var(--klh-dim); }
		.u-hz .u-cursor-y, .u-vt .u-cursor-x { width:100%; border-bottom:1px dashed var(--klh-dim); }
		.u-cursor-pt { position:absolute; top:0; left:0; border-radius:50%; border:0 solid; pointer-events:none; }
		.u-axis.u-off, .u-select.u-off, .u-cursor-x.u-off, .u-cursor-y.u-off, .u-cursor-pt.u-off { display:none; }
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
		this.flowPaused = false;
		this.edgeCharts = [];
		this.edgeRos = [];
		this.edgeChartFor = "";
		this.onVisibility = () => {
			this.flowPaused = document.hidden;
		};
		this.team = "";
		this.project = "";
		this.onData = (event) => {
			this.topology = event.detail;
		};
	}
	connectedCallback() {
		super.connectedCallback();
		// W858.7.33 deep link: the fragment restores layer/window/query/team/
		// project/hub; the link stays shareable as the viewer navigates.
		const fromHash = parseTopologyHash(location.hash);
		if (fromHash.layer) this.layer = fromHash.layer;
		if (fromHash.window === "1m") this.windowMs = 60_000;
		if (fromHash.window === "15m") this.windowMs = 900_000;
		if (fromHash.q) this.query = fromHash.q;
		if (fromHash.team) this.team = fromHash.team;
		if (fromHash.project) this.project = fromHash.project;
		if (fromHash.hub) this.selectedId = fromHash.hub;
		document.addEventListener("belt-topology-data", this.onData);
		document.addEventListener("visibilitychange", this.onVisibility);
		this.topology =
			document.querySelector("belt-topology")?.topology ?? this.topology;
	}
	syncHash() {
		const hash = serializeTopologyHash({
			layer: this.layer,
			window: this.windowMs === 60_000 ? "1m" : "15m",
			q: this.query,
			team: this.team,
			project: this.project,
			hub: this.selectedId ?? "",
		});
		history.replaceState(null, "", hash || location.pathname + location.search);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("belt-topology-data", this.onData);
		document.removeEventListener("visibilitychange", this.onVisibility);
		this.teardownEdgeChart();
	}
	onSearch(event) {
		this.query = event.target.value;
		this.syncHash();
	}
	select(id) {
		this.selectedId = id;
		this.syncHash();
	}
	onKey(event, id) {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		this.selectedId = id;
		this.syncHash();
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
	axisOptions(hubs, axis) {
		const names = new Set();
		for (const hub of hubs) for (const name of hub[axis] ?? []) names.add(name);
		return [...names].sort((a, b) => a.localeCompare(b));
	}
	windowComplete(graph, windowMs) {
		if (!graph) return false;
		return windowMs <= 60_000 || graph.totals.requests !== null;
	}
	inspector(view, graph) {
		const selected = view.hubs.find((hub) => hub.id === this.selectedId);
		if (selected) return this.inspectorDetail(selected, graph);
		const link = view.links.find((row) => row.id === this.selectedId);
		if (link) return this.edgeInspector(link);
		return html`<h3>Inspect a hub or a link</h3>
			<p>${this.selectedId ? "The selected element left the chosen window or layer." : "Select a hub card, a link, or a list row. The drawer keeps state, traffic, lane counts and the collapsed model inventory."}</p>
			<p class="coverage">The per-minute hop grid (drilldown) draws only for edges carrying measured 60s buckets.</p>`;
	}
	edgeInspector(link) {
		const fromLabel = link.from.replace("hub:", "");
		const toLabel = link.to.replace("hub:", "").replace("target:", "");
		const perMinute = (
			link.requests / Math.max(1, this.windowMs / 60_000)
		).toFixed(1);
		const laneNote =
			link.lanes === null
				? "unreported"
				: `${measure(link.lanes)} in the window · ${link.activeLanes === null ? "active unreported" : `${measure(link.activeLanes)} active`}`;
		return html`<h3>Link · ${fromLabel} → ${toLabel}</h3>
			<dl>
				<dt>Evidence</dt><dd>${link.evidence}${link.animate ? " · flow animating, speed bounded by the measured rate" : link.requests > 0 && link.evidence !== "ledger" ? " · stale, flow off" : ""}</dd>
				<dt>Hops</dt><dd>${measure(link.requests)} · ${perMinute}/min · width ${link.width}px</dd>
				<dt>Failed hops</dt><dd>${measure(link.failed)}</dd>
				<dt>Active requests</dt><dd>${measure(link.active)}</dd>
				<dt>Tokens in / out</dt><dd>${measure(link.inputTokens)} / ${measure(link.outputTokens)}</dd>
				<dt>Lanes</dt><dd>${laneNote}</dd>
				<dt>Last observed</dt><dd>${localTime(link.lastSeenAt)} · ${age(link.lastSeenAt)}</dd>
			</dl>
			${this.edgeChartSlot(link)}
			<details>
				<summary>Joined traces · ${link.traces.length}</summary>
				${
					link.traces.length
						? html`<ol class="trace-list">${link.traces.map(
								(trace) =>
									html`<li><code>${trace.id.slice(0, 12)}…</code> · ${trace.hops.join(" → ")} · ${trace.complete ? "complete" : "partial"}</li>`,
							)}</ol>`
						: html`<p>No joined W3C trace on this edge — a ledger target edge never claims a provider hop.</p>`
				}
			</details>
			${this.edgeGridTable(link)}`;
	}
	edgeChartSlot(link) {
		if (!link.series)
			return html`<p class="coverage">No per-minute grid for this edge — the snapshot cap or the schema level holds it back.</p>`;
		return html`<p class="coverage">Hops per minute over the snapshot window:</p>
			<div class="edge-chart" role="img" aria-label=${`Hops per minute: ${link.series.map((bucket) => bucket.requests).join(", ")}`}></div>`;
	}
	edgeGridTable(link) {
		const nonZero = (link.series ?? []).filter((bucket) => bucket.requests > 0);
		if (!nonZero.length) return "";
		return html`<details>
			<summary>Non-zero minutes</summary>
			<table class="edge-grid">
				<thead><tr><th>minute</th><th>hops</th><th>failed</th></tr></thead>
				<tbody>
					${nonZero.map(
						(bucket) =>
							html`<tr><td>${dualMinute(bucket.t)}</td><td>${bucket.requests}</td><td>${bucket.failed}</td></tr>`,
					)}
				</tbody>
			</table>
		</details>`;
	}
	inspectorDetail(selected, graph) {
		const traces = graph.traces
			.filter((trace) => trace.hops.includes(selected.label))
			.slice(0, 5);
		const models = this.hubModelsFor()[selected.label] ?? [];
		// W858.7.33: the server answered 403 topology.scope_denied — say so
		// instead of a misleading "none reported".
		const withheld =
			this.topology?.inventoryWithheld || this.topology?.supervisorWithheld;
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
				${
					selected.endpoints.length
						? html`<ul class="trace-list">${selected.endpoints.map(
								(item) =>
									html`<li>${item.label} · ${measure(item.requests)} hops · ${age(item.lastSeenAt)}</li>`,
							)}</ul>`
						: html`<p>No endpoint traffic in this window.</p>`
				}
			</details>
			<details>
				<summary>Model inventory · ${models.length}</summary>
				${
					models.length
						? html`<ul class="trace-list">${models.map(
								(model) => html`<li>${model}</li>`,
							)}</ul>`
						: withheld
							? html`<p class="coverage">Local model/lane detail withheld — topology scope required.</p>`
							: html`<p>No configured or Belt-served models reported.</p>`
				}
			</details>
			<h3>Joined traces</h3>
			${
				traces.length
					? html`<ol class="trace-list">${traces.map(
							(trace) =>
								html`<li><code>${trace.id.slice(0, 12)}…</code> · ${trace.hops.join(" → ")} · ${trace.complete ? "complete" : "partial"}</li>`,
						)}</ol>`
					: html`<p>No joined trace for this hub.</p>`
			}
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
				const classes = `hub-link ${link.evidence === "ledger" ? "ledger" : ""} ${link.failed > 0 ? "failed" : ""} ${link.animate ? "flow" : ""} ${this.selectedId === link.id ? "selected" : ""}`;
				const laneWord =
					link.lanes === null ? "lanes unreported" : `${link.lanes} lanes`;
				return svg`<g class="hub-item" role="button" tabindex="0" data-node=${link.id} aria-label=${`${link.from} to ${link.to}, ${link.requests} hops, ${laneWord}, ${link.evidence} evidence`} @click=${() => this.select(link.id)} @keydown=${(event) => this.onKey(event, link.id)}>
					<path class=${classes} style=${`stroke-width:${link.width}px${link.animate ? `;--flow-duration:${link.durationS}s` : ""}`} d=${path}></path>
					<path class="hit" d=${path}></path>
				</g>`;
			})}
			${layout.nodes.map(
				(
					node,
				) => svg`<g class="hub-item" role="button" tabindex="0" data-node=${node.id} aria-label=${`${node.label}, ${node.state}, ${node.requests} hops and ${node.failed} failures in the selected window, ${node.endpoints.length} observed endpoints`} @click=${() => this.select(node.id)} @keydown=${(event) => this.onKey(event, node.id)}>
					<rect class=${`hub-card ${node.state === "planned" ? "planned" : ""} ${this.selectedId === node.id ? "selected" : ""}`} x=${node.x} y=${node.y} width="190" height="64" rx="4"></rect>
					<circle class="hub-dot" cx=${node.x + 14} cy=${node.y + 17} r="3.5" fill=${stateColour(node.state)}></circle>
					<text class="hub-title" x=${node.x + 24} y=${node.y + 21}>${node.label.length > 21 ? `${node.label.slice(0, 20)}…` : node.label}</text>
					<text class="hub-sub" x=${node.x + 12} y=${node.y + 38}>${measure(node.requests)} hops · ${measure(node.failed)} failed</text>
					<text class="hub-sub" x=${node.x + 12} y=${node.y + 53}>${node.endpoints.length} endpoints · ${node.downstream.size} hubs · ${node.state}</text>
				</g>`,
			)}
		</svg>`;
	}

	updated(changed) {
		super.updated(changed);
		this.edgeChartTick();
	}

	edgeChartTick() {
		const link = this._view?.links.find(
			(row) => row.id === this.selectedId && row.series,
		);
		const key = link ? `${link.id}|${link.lastSeenAt}` : "";
		if (key === this.edgeChartFor) return;
		this.teardownEdgeChart();
		this.edgeChartFor = key;
		if (!link) return;
		this.drawEdgeChart(link);
	}

	drawEdgeChart(link) {
		const uPlot = globalThis.uPlot;
		const mount = this.renderRoot.querySelector(".edge-chart");
		if (!mount) return;
		if (!uPlot) {
			mount.textContent =
				"chart engine not loaded — non-zero minutes stay in the table below";
			return;
		}
		const times = link.series.map((bucket) => Math.round(bucket.t / 1000));
		this.chartEdge(uPlot, link, times, mount);
	}

	edgeChartTheme() {
		const themeToken = (name, fallback) =>
			getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim() || fallback;
		return {
			accent: () => themeToken("--klh-accent", "#8f8f74"),
			danger: () => themeToken("--klh-danger", "#c0392b"),
			axis: () => themeToken("--klh-chart-axis", "#898781"),
			grid: () => themeToken("--klh-chart-grid", "#2c2c2a"),
			int: (_u, v) => (v == null ? "—" : String(Math.round(v))),
		};
	}

	chartEdge(uPlot, link, times, mount) {
		const theme = this.edgeChartTheme();
		const data = [
			times,
			link.series.map((b) => b.requests),
			link.series.map((b) => b.failed),
		];
		const series = (label, stroke, points) => ({
			label,
			stroke,
			fill: () => `${stroke()}2e`,
			width: 1.5,
			points,
			value: theme.int,
		});
		const u = new uPlot(
			{
				width: mount.clientWidth || 280,
				height: 110,
				legend: { show: true, live: true },
				scales: { x: { time: true } },
				axes: [
					{
						stroke: theme.axis,
						grid: { show: true, stroke: theme.grid, width: 1 },
						ticks: { show: true, stroke: theme.axis, width: 1 },
					},
					{ stroke: theme.axis, grid: { show: false } },
				],
				series: [
					{},
					series("hops/min", theme.accent, {
						show: link.series.length < 16,
						size: 5,
					}),
					series("failed", theme.danger, { show: false }),
				],
			},
			data,
			mount,
		);
		this.edgeCharts.push(u);
		this.observeEdgeChartResize(mount, u);
	}

	observeEdgeChartResize(mount, u) {
		if (typeof ResizeObserver !== "function") return;
		const ro = new ResizeObserver(() => {
			const w = mount.clientWidth;
			if (w > 0 && w !== u.width) u.setSize({ width: w, height: 110 });
		});
		ro.observe(mount);
		this.edgeRos.push(ro);
	}

	teardownEdgeChart() {
		for (const u of this.edgeCharts) u.destroy?.();
		this.edgeCharts = [];
		for (const ro of this.edgeRos) ro.disconnect();
		this.edgeRos = [];
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
			team: this.team,
			project: this.project,
			hubModels: this.hubModelsFor(),
			configuredHubs: this.configuredHubsFor(data),
			now: Date.now(),
		});
		this._view = view;
		const layout = hubOverviewLayout(view.hubs, view.links);
		const selected =
			view.hubs.find((hub) => hub.id === this.selectedId) ?? null;
		return html`<section class=${this.flowPaused ? "flow-paused" : ""}>
			<h2>Hub topology · ${this.layer} layer</h2>
			<p role="status">${view.hubs.length} hubs · ${view.links.length} hub links · snapshot updated ${age(view.observedAt)}</p>
			<div class="controls">
				<fieldset>
					<legend>Layer radios: observed, connected, configured</legend>
					${["observed", "connected", "configured"].map(
						(name) =>
							html`<label><input type="radio" name="layer" .checked=${this.layer === name} @change=${() => {
								this.layer = name;
							}} />${name}</label>`,
					)}
				</fieldset>
				<fieldset>
					<legend>Window radios: 1m, 15m live; 1h, 24h disabled</legend>
					<label><input type="radio" name="window" .checked=${this.windowMs === 60_000} @change=${() => {
						this.windowMs = 60_000;
					}} />1m</label>
					<label><input type="radio" name="window" .checked=${this.windowMs === 1000 * 900} @change=${() => {
						this.windowMs = 900_000;
					}} />15m</label>
					<label><input type="radio" name="window" disabled title="The snapshot covers a 15m window — longer windows stay disabled rather than guess." />1h</label>
					<label><input type="radio" name="window" disabled title="The snapshot covers a 15m window — longer windows stay disabled rather than guess." />24h</label>
				</fieldset>
				<label class="search">Search
					<input type="search" .value=${this.query} placeholder="hub or model name" @input=${(event) => this.onSearch(event)} />
				</label>
				<fieldset>
					<legend>Team / project filters</legend>
					<label>Team
						<select @change=${(event) => {
							this.team = event.target.value;
							this.syncHash();
						}} aria-label="Filter hubs by team">
							<option value="">all teams</option>
							${this.axisOptions(view.hubs, "teams").map((name) => html`<option value=${name} ?selected=${this.team === name}>${name}</option>`)}
						</select>
					</label>
					<label>Project
						<select aria-label="Filter hubs by project" @change=${(event) => {
							this.project = event.target.value;
							this.syncHash();
						}}>
							<option value="">all projects</option>
						${this.axisOptions(view.hubs, "projects").map((name) => html`<option value=${name} ?selected=${this.project === name}>${name}</option>`)}
						</select>
					</label>
				</fieldset>
			</div>
			${
				view.search.length
					? html`<div class="results">Search hits: ${view.search.map(
							(hit) =>
								html`<button type="button" @click=${() => {
									this.select(hit.id);
									this.focusNode(hit.id);
								}}>${hit.label}${hit.kind === "model" ? ` via ${hit.via}` : ""}</button>`,
						)}</div>`
					: ""
			}
			<p class="crumbs">Estate${selected ? ` › ${selected.label}` : ""}${this.selectedId ? html` <button type="button" @click=${() => this.select("")}>Back to estate</button> ` : ""}</p>
			<div class="metrics" role="status">
				<div><strong>${measure(view.estate.hubs)}</strong><small>hubs in view</small></div>
				<div><strong>${measure(view.estate.endpoints)}</strong><small>observed endpoints</small></div>
				<div><strong>${measure(view.estate.requests)}</strong><small>hops · ${windowLabel(this.windowMs)}</small></div>
				<div><strong>${measure(view.estate.failed)}</strong><small>failed · ${windowLabel(this.windowMs)}</small></div>
			</div>
			<p class="legend" role="note">Edge width is measured — hops/min ≥0.5 → 2px, ≥3 → 3px, ≥8 → 4px, else 1px. Moving dashes ride fresh observed hops only, at a speed bounded by the measured rate; red = failures; dashed gray = ledger or planned, never animated. Reduced motion turns the flow off, and hiding the tab pauses it.</p>
			<div class="hubs-layout">
				<div class="hubs-map" style=${`--map-width:${layout.width}px`}>${this.renderMap(view, layout)}</div>
				<aside class="inspector">${this.inspector(view, graph)}</aside>
			</div>
			<h3>Hubs</h3>
			<table class="hub-list">
				<caption class="skip">All hubs with inspect buttons</caption>
				<tbody>
					${view.hubs.map(
						(hub) =>
							html`<tr><td>${hub.label}</td><td>${hub.state}</td><td>${measure(hub.requests)} hops</td><td><button type="button" @click=${() => this.select(hub.id)}>Inspect ${hub.label}</button></td></tr>`,
					)}
				</tbody>
			</table>
			<h3>Hub links</h3>
			<table class="link-list">
				<caption class="skip">All hub links with inspect buttons</caption>
				<tbody>
					${view.links.map(
						(link) =>
							html`<tr><td>${link.from.replace("hub:", "")}</td><td>${link.to.replace("hub:", "")}</td><td>${measure(link.requests)} hops · ${link.evidence}</td><td><button type="button" @click=${() => this.select(link.id)}>Inspect link</button></td></tr>`,
					)}
				</tbody>
			</table>
			<p class="coverage">Snapshot window ${windowLabel(this.windowMs)} · projection ${graph.coverage?.projectionAvailable ? "available" : "unavailable"} · ledger ${graph.coverage?.ledgerAvailable ? "available" : "unavailable"} · ${measure(graph.coverage?.tracesReturned)} of ${measure(graph.coverage?.tracesTotal)} traces returned.</p>
		</section>`;
	}
}

customElements.define("belt-topology-hubs", BeltTopologyHubs);
