import { buildTopology } from "/dashboard-topology-model.js";
import { css, html, LitElement, svg } from "/vendor/lit.js";

const colour = (state) =>
	state === "up"
		? "var(--klh-ok-ink)"
		: state === "routed"
			? "var(--klh-accent)"
			: state === "attention"
				? "var(--klh-accent)"
				: state === "down"
					? "var(--klh-danger)"
					: "var(--klh-dim)";

class BeltTopology extends LitElement {
	static properties = {
		topology: { state: true },
		error: { state: true },
		networkIssue: { state: true },
	};
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		.heading { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		p, .legend { color:var(--klh-dim); font-size:var(--klh-text-sm); margin:var(--klh-space-2) 0; }
		button { margin-left:auto; background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		.map { width:100%; overflow-x:auto; }
		svg { display:block; width:100%; min-width:780px; height:auto; font:12px var(--klh-font-sans, sans-serif); }
		.edge { fill:none; stroke:var(--klh-edge); stroke-width:1.5; stroke-dasharray:5 5; }
		.machine { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1.5; }
		.buckle { fill:var(--klh-accent-wash); stroke:var(--klh-accent); stroke-width:1; }
		.belt { fill:var(--klh-edge-faint); stroke:var(--klh-edge); stroke-width:1; }
		.cloud { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1; }
		.title { fill:var(--klh-ink); font-weight:600; }
		.meta { fill:var(--klh-dim); }
		.endpoint { font-variant-numeric:tabular-nums; }
		.group { fill:var(--klh-dim); font-size:10px; letter-spacing:1.3px; }
		.traffic { display:flex; flex-wrap:wrap; gap:var(--klh-space-2); margin:var(--klh-space-3) 0; }
		.traffic span { display:flex; align-items:baseline; gap:6px; padding:6px 10px; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); font-size:var(--klh-text-sm); }
		.traffic strong { font-variant-numeric:tabular-nums; }
		.traffic small { color:var(--klh-dim); font:inherit; }
	`;
	constructor() {
		super();
		this.topology = null;
		this.error = "";
		this.networkIssue = "";
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
			try {
				const [response, accessResponse] = await Promise.all([
					fetch("/api/network", {
						signal: controller.signal,
						cache: "no-store",
					}),
					fetch("/api/model-access", {
						signal: controller.signal,
						cache: "no-store",
					}),
				]);
				const network = response.ok ? await response.json() : null;
				const access = accessResponse.ok ? await accessResponse.json() : null;
				this.networkIssue =
					network?.ok && network.network?.ok
						? ""
						: "Buckle request feed unavailable";
				this.topology = buildTopology(
					status,
					remotes,
					supervisor,
					Date.now(),
					network,
					access,
				);
			} catch {
				this.networkIssue = "Buckle request feed unavailable";
			}
		} catch (error) {
			if (controller.signal.aborted && this.controller !== controller) return;
			this.error = `Connection data unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
		}
	}
	shortModel(value, length = 29) {
		const name = String(value).split("/").pop();
		return name.length > length ? `${name.slice(0, length - 1)}…` : name;
	}
	machine(x, y, width, height, title, buckle, state, models, local = false) {
		return svg`<g><rect class="machine" x=${x} y=${y} width=${width} height=${height} rx="6"></rect>
			<circle cx=${x + 17} cy=${y + 21} r="4" fill=${colour(state)}></circle><text class="title" x=${x + 30} y=${y + 25}>${title}</text>
			<rect class="buckle" x=${x + 16} y=${y + 38} width=${width - 32} height="44" rx="4"></rect>
			<text class="title" x=${x + 30} y=${y + 57}>Buckle</text><text class="meta" x=${x + 30} y=${y + 73}>${buckle}</text>
			<rect class="belt" x=${x + 16} y=${y + 96} width=${width - 32} height="24" rx="3"></rect>
			<text class="title" x=${x + 28} y=${y + 113}>Belt · local models</text>
			${
				models.length
					? models.map((item, index) => {
							const column = local ? index % 2 : 0;
							const row = local ? Math.floor(index / 2) : index;
							const itemX = x + 30 + column * 186;
							const itemY = y + 142 + row * (local ? 48 : 39);
							return svg`<g><title>${item.model}</title>
								<circle cx=${itemX} cy=${itemY} r="3" fill=${colour(item.state)}></circle>
								<text class="title" x=${itemX + 12} y=${itemY + 4}>${local ? `${item.port === 8912 ? "Kev" : item.role} · ${item.label}` : `${title.split(" · hub")[0]}/${this.shortModel(item.model, 18)}`}</text>
								<text class="meta endpoint" x=${itemX + 12} y=${itemY + 20}>${local ? this.shortModel(item.model, 22) : "configured in remote inventory"}</text>
								${local ? svg`<text class="meta endpoint" x=${itemX + 12} y=${itemY + 34}>${item.load5m === null ? "Belt load unreported" : `${item.load5m} Belt req/5m`}</text>` : ""}
							</g>`;
						})
					: svg`<text class="meta" x=${x + 28} y=${y + 151}>No model inventory reported</text>`
			}
		</g>`;
	}
	cloud(x, y, width, item) {
		const visible = item.models.slice(0, 4);
		const height =
			54 + Math.max(1, visible.length) * 19 + (item.models.length > 4 ? 20 : 0);
		return svg`<g><rect class="cloud" x=${x} y=${y} width=${width} height=${height} rx="5"></rect>
			<circle cx=${x + 16} cy=${y + 20} r="3.5" fill=${colour(item.routeObserved ? "routed" : item.state)}></circle>
			<text class="title" x=${x + 28} y=${y + 24}>${item.name}${item.state === "unconfigured" ? " · direct API" : ""}</text>
			<text class="meta endpoint" x=${x + 14} y=${y + 43}>${item.kind === "copilot" ? `${item.models.length} selectable · ${item.buckleCount} Buckle routes` : Number.isFinite(item.buckleReq15) ? `${item.buckleReq15} Buckle req/15m · ${Number.isFinite(item.outTokens60) ? `${(item.outTokens60 / 60).toFixed(1)} output tok/s` : "output tokens unreported"}` : item.state === "unconfigured" ? "No direct API key · Copilot is a separate route" : item.probed === 0 && item.reachable === 0 ? `Direct API probe failed · ${item.routed} Belt routes` : `${item.reachable}/${item.endpoints} probes · ${item.routed} recent Belt routes`}</text>
			${visible.length ? visible.map((model, index) => svg`<text class="meta" x=${x + 14} y=${y + 62 + index * 19}>${item.kind === "copilot" ? `local/Copilot/${this.shortModel(model, 23)}` : this.shortModel(model, 35)}</text>`) : svg`<text class="meta" x=${x + 14} y=${y + 62}>${item.kind === "copilot" ? "Copilot catalog unavailable" : item.state === "unconfigured" ? "Direct API catalog requires its own key" : "Model inventory unobserved"}</text>`}
			${item.models.length > 4 ? svg`<a href="#modelaccess"><text class="meta" x=${x + 14} y=${y + 62 + visible.length * 19}>${item.models.length - visible.length} more · view model access</text></a>` : ""}
		</g>`;
	}
	render() {
		const data = this.topology;
		const machines = data?.machines ?? [];
		const hubs = data?.hubs ?? [];
		const models = data?.specialists.models ?? [];
		const hubNames = new Set(hubs.map((item) => item.name.toLowerCase()));
		const clouds = machines.filter(
			(item) => !hubNames.has(item.name.toLowerCase()),
		);
		if (data?.copilot)
			clouds.unshift({
				name: "IKEA Copilot",
				kind: "copilot",
				state: data.copilot.state === "catalog reachable" ? "up" : "unknown",
				models: data.copilot.models.map(
					(model) => model.routes?.[0] ?? model.id,
				),
				buckleCount: data.copilot.models.filter((model) => model.buckle).length,
			});
		let hubY = 52;
		const hubCards = hubs.map((item) => {
			const inventory = machines.find(
				(machine) => machine.name.toLowerCase() === item.name.toLowerCase(),
			);
			const remoteModels = (inventory?.models ?? []).map((model) => ({
				model,
				state: inventory.state,
			}));
			const card = {
				...item,
				y: hubY,
				height: Math.max(162, 132 + remoteModels.length * 39),
				models: remoteModels,
			};
			hubY += card.height + 18;
			return card;
		});
		const cloudHeight = clouds.reduce(
			(sum, item) =>
				sum +
				68 +
				Math.max(1, Math.min(4, item.models.length)) * 19 +
				(item.models.length > 4 ? 20 : 0),
			0,
		);
		const localHeight = Math.max(195, 132 + Math.ceil(models.length / 2) * 48);
		const height = Math.max(350, 52 + localHeight, hubY, 52 + cloudHeight);
		let cloudY = 52;
		return html`<section aria-label="Belt connection map">
			<div class="heading"><h2>Connections</h2><button type="button" @click=${this.refresh}>Refresh map</button></div>
			<p role="status">${this.error || (data ? `${models.length} local models · ${hubs.length} hub probes · ${clouds.length} provider groups` : "Loading observed connections…")}</p>
			${
				data?.gatewayTraffic
					? html`<div class="traffic" aria-label="Observed Buckle traffic, past 60 seconds">
				<span><strong>${data.gatewayTraffic.requests60}</strong><small>Buckle requests / min</small></span>
				<span><strong>${Math.round((data.gatewayTraffic.inputTokens60 + data.gatewayTraffic.outputTokens60) / 60).toLocaleString("en-US")}</strong><small>reported tokens / sec</small></span>
				<span><strong>${data.gatewayTraffic.observedTargets}</strong><small>active gateway targets</small></span>
			</div>`
					: ""
			}
			${
				data
					? html`<div class="map"><svg viewBox=${`0 0 1190 ${height}`} role="img" aria-label="Local machine contains Buckle and Belt models; Buckle links lead to hub machines; cloud providers are listed beyond hubs">
				<text class="group" x="20" y="35">LOCAL MACHINE</text><text class="group" x="470" y="35">HUB MACHINES</text>
				<text class="group" x="850" y="35">CLOUD GATEWAYS · OBSERVED ROUTES</text>
				${hubCards.map((item) => svg`<path class="edge" d=${`M420 112 H447 V${item.y + 60} H470`}></path>`)}
					${this.machine(20, 52, 400, localHeight, "This Mac", `local spoke · :4101 · ${data.gateway === "unknown" ? "state unobserved" : data.gateway}`, data.gateway, models, true)}
				${hubCards.map((item) => this.machine(470, item.y, 320, item.height, `${item.displayName || item.name} · hub`, `:${item.port} · ${item.state} probe`, item.state, item.models))}
				${clouds.map((item) => {
					const y = cloudY;
					cloudY +=
						68 +
						Math.max(1, Math.min(4, item.models.length)) * 19 +
						(item.models.length > 4 ? 20 : 0);
					return this.cloud(850, y, 320, item);
				})}
			</svg></div>
			<div class="legend">Machine boxes contain Buckle and a Belt model strip. Dashed links show hub probes. Gateway traffic counts Buckle requests; model loads count direct Belt router calls. Cloud provider cards need verified hop records before links can be drawn.${this.networkIssue ? ` ${this.networkIssue}.` : " Token rates use reported usage over 60 seconds."}</div>`
					: ""
			}
		</section>`;
	}
}

customElements.define("belt-topology", BeltTopology);
