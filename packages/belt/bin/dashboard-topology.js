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
		h3 { font:inherit; font-size:var(--klh-text-sm); margin:var(--klh-space-3) 0 var(--klh-space-2); }
		p, .legend { color:var(--klh-dim); font-size:var(--klh-text-sm); margin:var(--klh-space-2) 0; }
		.heading + p { min-block-size:28px; }
		button { margin-left:auto; background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		.map { inline-size:100%; block-size:440px; overflow:auto; }
		svg { display:block; inline-size:1060px; block-size:auto; font:12px var(--klh-font-sans, sans-serif); }
		.edge { fill:none; stroke:var(--klh-dim); stroke-dasharray:4 5; }
		.edge.observed { stroke:var(--klh-info); stroke-dasharray:none; }
		.edge-label { fill:var(--klh-ink-2); font-size:10px; font-variant-numeric:tabular-nums; }
		.machine { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1.5; }
		.buckle { fill:var(--klh-accent-wash); stroke:var(--klh-accent); stroke-width:1; }
		.belt { fill:var(--klh-edge-faint); stroke:var(--klh-edge); stroke-width:1; }
		.cloud { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1; }
		.title { fill:var(--klh-ink); font-weight:600; }
		.meta { fill:var(--klh-dim); }
		.endpoint { font-variant-numeric:tabular-nums; }
		.console-link { fill:var(--klh-accent); font-size:10px; text-decoration:underline; }
		a:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.work-box { fill:var(--klh-edge-faint); stroke:var(--klh-edge); }
		.work-label { fill:var(--klh-ink); font-size:11px; font-weight:600; }
		.work-counts { fill:var(--klh-dim); font-size:10px; font-variant-numeric:tabular-nums; }
		.group { fill:var(--klh-dim); font-size:10px; letter-spacing:1.3px; }
		.traffic { display:flex; flex-wrap:wrap; gap:var(--klh-space-2); min-block-size:34px; margin:var(--klh-space-3) 0; }
		.traffic span { display:flex; align-items:baseline; gap:6px; padding:4px 8px; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); font-size:var(--klh-text-sm); }
		.traffic strong { font-variant-numeric:tabular-nums; }
		.traffic small { color:var(--klh-dim); font:inherit; }
		details { color:var(--klh-ink-2); font-size:var(--klh-text-sm); margin-top:var(--klh-space-2); }
		summary { cursor:pointer; }
		summary:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		table { border-collapse:collapse; width:min(100%, 740px); margin-top:var(--klh-space-2); }
		th, td { text-align:left; padding:5px 12px 5px 0; border-bottom:1px solid var(--klh-edge-faint); }
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
		this.timer = setInterval(() => this.refresh(), 10_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		this.controller?.abort();
	}
	async refresh() {
		if (this.inFlight) return;
		this.inFlight = true;
		const controller = new AbortController();
		this.controller = controller;
		const timeout = setTimeout(() => controller.abort(), 6000);
		try {
			const [
				statusResponse,
				remotesResponse,
				supervisorResponse,
				networkResponse,
				accessResponse,
				contextResponse,
			] = await Promise.all([
				...["/api/status", "/api/remotes", "/api/supervisor"].map((url) =>
					fetch(url, { signal: controller.signal, cache: "no-store" }),
				),
				fetch("/api/network", {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
				fetch("/api/model-access", {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
				fetch("/api/topology-context", {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
			]);
			if (!statusResponse.ok || !remotesResponse.ok || !supervisorResponse.ok)
				throw new Error("A topology feed is unavailable");
			const [status, remotes, supervisor, network, access, context] =
				await Promise.all([
					statusResponse.json(),
					remotesResponse.json(),
					supervisorResponse.json(),
					networkResponse?.ok ? networkResponse.json().catch(() => null) : null,
					accessResponse?.ok ? accessResponse.json().catch(() => null) : null,
					contextResponse?.ok ? contextResponse.json().catch(() => null) : null,
				]);
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
				context,
			);
			this.error = "";
		} catch (error) {
			if (controller.signal.aborted && this.controller !== controller) return;
			this.error = `Connection data unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
			this.inFlight = false;
		}
	}
	shortModel(value, length = 29) {
		const name = String(value).split("/").pop();
		return name.length > length ? `${name.slice(0, length - 1)}…` : name;
	}
	edge(path, link) {
		const observed = link.evidence === "observed";
		const width = observed
			? Math.min(4, 1 + Math.log10(1 + link.requests15))
			: 1.5;
		return svg`<g><title>${observed ? `${link.requests15} observed successful requests in 15 minutes · ${link.source}` : link.evidence === "probe" ? `Hub reachability probe · ${link.source}` : `Configured provider path · ${link.requests15 ?? "unavailable"} observed successes in 15 minutes · ${link.source}`}</title><path class=${observed ? "edge observed" : "edge"} d=${path} stroke-width=${width}></path></g>`;
	}
	machine(
		x,
		y,
		width,
		height,
		title,
		buckle,
		state,
		models,
		local = false,
		consoleUrl = null,
		work = null,
	) {
		const counts =
			work &&
			["ready", "working", "waiting", "blocked", "failed", "done"].every(
				(key) => Number.isFinite(work[key]),
			)
				? `R ${work.ready}  W ${work.working}  S ${work.waiting}  B ${work.blocked}  F ${work.failed}  D ${work.done}`
				: null;
		return svg`<g><rect class="machine" x=${x} y=${y} width=${width} height=${height} rx="6"></rect>
			<circle cx=${x + 14} cy=${y + 18} r="3.5" fill=${colour(state)}></circle><text class="title" x=${x + 25} y=${y + 22}>${title}</text>
			${consoleUrl ? svg`<a href=${consoleUrl} target="_blank" rel="noopener noreferrer" aria-label=${`Open ${title} console in a new tab`}><text class="console-link" x=${x + width - 44} y=${y + 22}>Open ↗</text></a>` : ""}
			<rect class="buckle" x=${x + 12} y=${y + 34} width=${width - 24} height="40" rx="3"></rect>
			<text class="title" x=${x + 23} y=${y + 50}>Buckle</text><text class="meta endpoint" x=${x + 23} y=${y + 66}>${buckle}</text>
			<rect class="belt" x=${x + 12} y=${y + 86} width=${width - 24} height="22" rx="2"></rect>
			<text class="title" x=${x + 23} y=${y + 102}>Belt · ${models.length} ${local ? "local models" : "listed models"}</text>
			${
				models.length
					? models.map((item, index) => {
							const column = local ? index % 2 : 0;
							const row = local ? Math.floor(index / 2) : index;
							const itemX = x + 21 + column * 176;
							const itemY = y + 125 + row * (local ? 41 : 35);
							return svg`<g><title>${item.model}</title>
								<circle cx=${itemX} cy=${itemY} r="3" fill=${colour(item.state)}></circle>
								<text class="title" x=${itemX + 10} y=${itemY + 4}>${local ? `${item.port === 8912 ? "Kev" : item.role} · ${item.label}` : this.shortModel(item.model, 23)}</text>
								<text class="meta endpoint" x=${itemX + 10} y=${itemY + 18}>${local ? this.shortModel(item.model, 20) : "remote inventory"}</text>
								${local ? svg`<text class="meta endpoint" x=${itemX + 10} y=${itemY + 31}>${item.load5m === null ? "Belt load unreported" : `${item.load5m} Belt req/5m`}</text>` : ""}
							</g>`;
						})
					: svg`<text class="meta" x=${x + 22} y=${y + 132}>No model inventory reported</text>`
			}
			${
				local
					? svg`<g aria-label=${counts ? `Suspenders Work Graph: ready ${work.ready}, working ${work.working}, waiting ${work.waiting}, blocked ${work.blocked}, failed ${work.failed}, done ${work.done}` : "Suspenders Work Graph status unavailable"}>
				<rect class="work-box" x=${x + 12} y=${y + height - 48} width=${width - 24} height="36" rx="2"></rect>
				<text class="work-label" x=${x + 22} y=${y + height - 31}>Suspenders · Work Graph</text>
				<text class="work-counts" x=${x + 22} y=${y + height - 17}>${counts ?? "Status unavailable"}</text>
				<title>R ready · W working · S waiting · B blocked · F failed · D done. Counts cover all projects.</title>
			</g>`
					: ""
			}
		</g>`;
	}
	cloud(x, y, width, item, link) {
		const visible = item.models.slice(0, 2);
		const status = Number.isFinite(link?.requests15)
			? `${link.requests15} successful /15m · ${link.failures15 ?? "—"} target failures`
			: item.state === "unconfigured"
				? "Direct API key not configured"
				: item.kind === "copilot"
					? `${item.catalog?.models?.length ?? 0} selectable · ${item.catalog?.state ?? "catalog unknown"}`
					: `${item.reachable}/${item.endpoints} probes · traffic unavailable`;
		return svg`<g><rect class="cloud" x=${x} y=${y} width=${width} height="86" rx="3"></rect>
			<circle cx=${x + 14} cy=${y + 18} r="3.5" fill=${colour(item.routeObserved ? "routed" : item.state)}></circle>
			<text class="title" x=${x + 25} y=${y + 22}>${item.name}</text>
			<g><title>${link ? `${link.source} · last evidence ${localTime(link.lastSeen)}` : "No measured Buckle route data"}</title><text class="meta endpoint" x=${x + 12} y=${y + 39}>${status}</text></g>
			${visible.length ? visible.map((model, index) => svg`<g><title>${model}</title><text class="meta" x=${x + 12} y=${y + 58 + index * 16}>${this.shortModel(model, 35)}</text></g>`) : svg`<text class="meta" x=${x + 12} y=${y + 58}>Model inventory unavailable</text>`}
			${item.models.length > 2 ? svg`<a href="#modelaccess"><text class="meta" x=${x + 158} y=${y + 75}>+${item.models.length - 2} in model access</text></a>` : ""}
		</g>`;
	}
	render() {
		const data = this.topology;
		const machines = data?.machines ?? [];
		const hubs = [...(data?.hubs ?? [])].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		const models = data?.specialists.models ?? [];
		const clouds = [...(data?.providers ?? [])].sort((a, b) =>
			a.key === "copilot"
				? -1
				: b.key === "copilot"
					? 1
					: a.key.localeCompare(b.key),
		);
		let hubY = 65;
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
				height: Math.max(150, 120 + remoteModels.length * 35),
				models: remoteModels,
			};
			hubY += card.height + 12;
			return card;
		});
		const localHeight = Math.max(198, 168 + Math.ceil(models.length / 2) * 41);
		const height = Math.max(
			440,
			65 + localHeight,
			hubY,
			65 + clouds.length * 94,
		);
		const cloudCards = clouds.map((item, index) => ({
			...item,
			y: 65 + index * 94,
		}));
		const traffic = data?.gatewayTraffic;
		const audit = data?.audit15;
		const tokenRate =
			Number.isFinite(traffic?.inputTokens60) &&
			Number.isFinite(traffic?.outputTokens60)
				? Math.round(
						(traffic.inputTokens60 + traffic.outputTokens60) / 60,
					).toLocaleString("en-US")
				: "—";
		return html`<section aria-label="Belt connection map">
			<div class="heading"><h2>Connections</h2><button type="button" @click=${this.refresh}>Refresh map</button></div>
			<p role="status">${this.error || (data ? `${models.length} local models · ${hubs.length} hubs · ${clouds.length} providers${this.networkIssue ? ` · ${this.networkIssue}` : ""}` : "Loading connections…")}</p>
			<div class="traffic" aria-label="Successful Buckle routes, past 60 seconds">
				<span><strong>${traffic?.requests60 ?? "—"}</strong><small>successful Buckle routes / min</small></span>
				<span><strong>${tokenRate}</strong><small>reported tokens / sec</small></span>
				<span><strong>${traffic?.observedTargets ?? "—"}</strong><small>active successful routes</small></span>
			</div>
			<p class="legend">${
				audit
					? `Local Buckle ledger · 15m: ${audit.attempts} attempts, ${audit.succeeded} successful, ${audit.failed} failed, ${audit.unsettled} without outcome · latest audit ${localTime(data.lastAuditAt)} · latest success ${localTime(data.recentSuccessAt)}.`
					: "Local Buckle route audit unavailable; path counts cannot be measured."
			}</p>
			${
				data
					? html`<div class="map"><svg viewBox=${`0 0 1060 ${height}`} role="img" aria-label="This Mac and its models, connected to hub probes and cloud providers. Solid blue links are observed Buckle requests; dashed links are configured paths or probes.">
				<text class="group" x="16" y="28">LOCAL MACHINE</text><text class="group" x="430" y="28">HUBS</text>
				<text class="group" x="770" y="28">CLOUD PROVIDERS</text>
				${hubCards.map((item) => {
					const link = data.links.find(
						(entry) => entry.target === `hub:${item.name.toLowerCase()}`,
					);
					return link
						? this.edge(`M386 113 H408 V${item.y + 54} H430`, link)
						: "";
				})}
				${cloudCards.map((item) => {
					const link = data.links.find(
						(entry) => entry.target === `provider:${item.key}`,
					);
					return link
						? this.edge(`M386 113 H403 V51 H742 V${item.y + 42} H770`, link)
						: "";
				})}
				${this.machine(16, 65, 370, localHeight, "This Mac", `local spoke · :4101 · ${data.gateway === "unknown" ? "unobserved" : data.gateway}`, data.gateway, models, true, data.localConsoleUrl, data.work)}
				${hubCards.map((item) => this.machine(430, item.y, 275, item.height, item.displayName || item.name, `:${item.port} · ${item.state} probe`, item.state, item.models, false, item.consoleUrl))}
					${cloudCards.map((item) =>
						this.cloud(
							770,
							item.y,
							275,
							item,
							data.links.find((link) => link.target === `provider:${item.key}`),
						),
					)}
			</svg></div>`
					: html`<div class="map" aria-busy="true"><p>Loading map…</p></div>`
			}
			<div class="legend">Solid blue: observed successful routes in the past 15 minutes. Dashed: configured provider path or hub probe. Hub request counts require the separate hub observation feed. Local model loads count Belt router calls.</div>
			<details><summary>Connection data · ${data?.links.length ?? 0} paths</summary>
				<table><thead><tr><th scope="col">Target</th><th scope="col">Path</th><th scope="col">Successful / 15m</th><th scope="col">Target failures / 15m</th><th scope="col">Source</th><th scope="col">Last evidence</th></tr></thead>
				<tbody>${(data?.links ?? []).map((link) => html`<tr><td>${link.target.replace(/^hub:|^provider:/, "")}</td><td>${link.evidence}</td><td>${link.requests15 ?? "—"}</td><td>${link.failures15 ?? "—"}</td><td>${link.source}</td><td title=${link.lastSeen ? new Date(link.lastSeen).toISOString() : "No observed route"}>${localTime(link.lastSeen)}</td></tr>`)}</tbody></table>
				${audit?.unattributedFailed ? html`<p>${audit.unattributedFailed} failed requests have no target attribution in the Buckle ledger.</p>` : ""}
				${
					audit?.failures?.length
						? html`<h3>Failed Buckle attempts · recorded target</h3>
						<table><thead><tr><th scope="col">Target</th><th scope="col">Failures / 15m</th><th scope="col">Last failure</th></tr></thead>
							<tbody>${audit.failures.map((row) => html`<tr><td>${row.host ? `${row.kind} · ${row.host}${row.port ? `:${row.port}` : ""}` : "Target unrecorded"}</td><td>${row.count}</td><td title=${row.lastAt}>${localTime(row.lastAt)}</td></tr>`)}</tbody></table>`
						: ""
				}
			</details>
		</section>`;
	}
}

customElements.define("belt-topology", BeltTopology);
