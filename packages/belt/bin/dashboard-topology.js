import { css, html, LitElement, svg } from "/vendor/lit.js";
import { buildTopology } from "/dashboard-topology-model.js";

const colour = (state) =>
	state === "up"
		? "var(--klh-ok-ink)"
		: state === "attention"
			? "var(--klh-accent)"
			: state === "down"
				? "var(--klh-danger)"
				: "var(--klh-dim)";

class BeltTopology extends LitElement {
	static properties = { topology: { state: true }, error: { state: true } };
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		.heading { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		p, .legend { color:var(--klh-dim); font-size:var(--klh-text-sm); margin:var(--klh-space-2) 0; }
		button { margin-left:auto; background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		.map { width:100%; overflow-x:auto; }
		svg { display:block; width:100%; min-width:740px; height:auto; font:12px var(--klh-font-sans, sans-serif); }
		.edge { fill:none; stroke:var(--klh-edge); stroke-width:2; stroke-dasharray:5 5; }
		.edge.routed { stroke:var(--klh-accent); stroke-dasharray:none; }
		.node { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1.5; }
		.title { fill:var(--klh-ink); font-weight:600; }
		.meta { fill:var(--klh-dim); }
		.endpoint { font-variant-numeric:tabular-nums; }
		.group { fill:var(--klh-dim); font-size:10px; letter-spacing:1.3px; }
	`;
	constructor() {
		super();
		this.topology = null;
		this.error = "";
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 5_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		this.controller?.abort();
	}
	async refresh() {
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		const timeout = setTimeout(() => controller.abort(), 6000);
		try {
			const responses = await Promise.all(
				["/api/status", "/api/remotes", "/api/supervisor"].map((url) =>
					fetch(url, { signal: controller.signal, cache: "no-store" }),
				),
			);
			if (responses.some((response) => !response.ok))
				throw new Error("A topology feed is unavailable");
			const [status, remotes, supervisor] = await Promise.all(
				responses.map((response) => response.json()),
			);
			this.topology = buildTopology(status, remotes, supervisor);
			this.error = "";
		} catch (error) {
			if (controller.signal.aborted && this.controller !== controller) return;
			this.error = `Connection data unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
		}
	}
	node(x, y, width, title, meta, state, full = "") {
		return svg`<g><title>${full || `${title} · ${meta}`}</title><rect class="node" x=${x} y=${y} width=${width} height="48" rx="5"></rect>
			<circle cx=${x + 13} cy=${y + 16} r="3.5" fill=${colour(state)}></circle>
			<text class="title" x=${x + 24} y=${y + 20}>${title}</text>
			<text class="meta endpoint" x=${x + 12} y=${y + 37}>${meta}</text></g>`;
	}
	render() {
		const data = this.topology;
		const machines = data?.machines ?? [];
		const hubs = data?.hubs ?? [];
		const models = data?.specialists.models ?? [];
		const right = [
			...hubs.map((item) => ({
				title: `${item.name} hub · :${item.port}`,
				meta: `${item.state} · active workload unavailable`,
				state: item.state,
				routed: 0,
			})),
			...machines.map((item) => ({
				title: `${item.name} · ${item.reachable}/${item.endpoints} endpoints`,
				meta: `${item.routed} successful routes in 15m`,
				state: item.state,
				routed: item.routed,
			})),
		];
		const height = Math.max(
			480,
			48 + Math.max(models.length, right.length) * 58,
		);
		const centre = Math.round(height / 2);
		const routes = machines.reduce((sum, item) => sum + item.routed, 0);
		const providerText = machines.length
			? `${machines.length} remote groups · ${routes} routed in 15m`
			: "No remote endpoints reported";
		return html`<section aria-label="Belt connection map">
			<div class="heading"><h2>Connections</h2><button type="button" @click=${this.refresh}>Refresh map</button></div>
			<p role="status">${this.error || (data ? `Local router ${data.router} · ${models.length} local models · ${providerText}` : "Loading observed connections…")}</p>
			${
				data
					? html`<div class="map"><svg viewBox=${`0 0 1160 ${height}`} role="img" aria-label="This Mac and its Belt router, individual local models, hub probes, and remote endpoints">
				<text class="group" x="486" y="16">LOCAL MODELS · BELT ROUTES IN LAST 5 MINUTES</text>
				<text class="group" x="832" y="16">HUBS AND REMOTE ENDPOINTS</text>
				<path class="edge" d=${`M185 ${centre} H225`}></path>
				<path class="edge" d=${`M410 ${centre} H458 V48`}></path>
				<path class="edge" d=${`M458 48 V${48 + Math.max(0, models.length - 1) * 58}`}></path>
				<path class="edge" d=${`M410 ${centre} H804 V48`}></path>
				<path class="edge" d=${`M804 48 V${48 + Math.max(0, right.length - 1) * 58}`}></path>
				${this.node(20, centre - 24, 165, "This Mac", "Belt dashboard", data.router)}
				${this.node(225, centre - 24, 185, "Belt router", `:4000 · ${data.router}`, data.router)}
				${models.map((item, index) => svg`<path class="edge" d=${`M458 ${48 + index * 58} H486`}></path>${this.node(486, 24 + index * 58, 290, `${item.role} · :${item.port}`, `${item.label} · ${item.load5m === null ? "Belt load unreported" : `${item.load5m} Belt req/5m`}`, item.state, String(item.model))}`)}
				${right.map((item, index) => svg`<path class=${item.routed ? "edge routed" : "edge"} d=${`M804 ${48 + index * 58} H832`}></path>${this.node(832, 24 + index * 58, 308, item.title, item.meta, item.state)}`)}
			</svg></div>
			<div class="legend">Dots show the last health observation. Dashed links are configured or probed paths; a solid link has a successful route in the past 15 minutes. Model load counts Belt router calls only. Lane counts, hub workloads and token throughput await Buckle telemetry.</div>`
					: ""
			}
		</section>`;
	}
}

customElements.define("belt-topology", BeltTopology);
