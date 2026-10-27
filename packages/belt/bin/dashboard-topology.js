import {
	buildTopology,
	observedGraphLayout,
} from "./dashboard-topology-model.js";
import { css, html, LitElement, svg } from "./vendor/lit.js";

const readApi = (path) => `${globalThis.KLH_GATEWAY_READ_BASE ?? ""}${path}`;

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

const measure = (value) =>
	Number.isFinite(value) ? value.toLocaleString("en-US") : "unreported";

const costCaption = (price) => {
	if (price?.status === "free") return "FREE";
	if (
		price?.status === "priced" &&
		Number.isFinite(price.inputUsdPerMillion) &&
		Number.isFinite(price.outputUsdPerMillion)
	)
		return `$${price.inputUsdPerMillion} / $${price.outputUsdPerMillion}`;
	if (price?.status === "included-unreported") return "included · rate n/a";
	if (price?.status === "local-unpriced") return "local · rate n/a";
	return "price unknown";
};

const costDetail = (price) =>
	`${costCaption(price)}${price?.status === "priced" ? " USD per 1M input / output tokens" : ""}${price?.source ? ` · source: ${price.source}` : ""}${price?.fetchedAt ? ` · fetched ${localTime(price.fetchedAt)}` : ""}`;

const age = (value) => {
	const elapsed = Date.now() - Date.parse(value);
	if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
	if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
	return `${Math.floor(elapsed / 60_000)}m ago`;
};

export class BeltTopology extends LitElement {
	static properties = {
		topology: { state: true },
		error: { state: true },
		networkIssue: { state: true },
		selectedId: { state: true },
		expandedHubs: { state: true },
		query: { state: true },
		pageVisible: { state: true },
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
		.map { inline-size:100%; block-size:610px; overflow:auto; }
		svg { display:block; inline-size:min(100%, 1000px); min-inline-size:900px; block-size:auto; font:12px var(--klh-font-sans, sans-serif); }
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
		.model-toggle { fill:var(--klh-accent); cursor:pointer; text-decoration:underline; font-size:10px; }
		.model-toggle-hit { fill:transparent; cursor:pointer; }
		.model-toggle-group:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.traffic { display:flex; flex-wrap:wrap; gap:var(--klh-space-2); min-block-size:34px; margin:var(--klh-space-3) 0; }
		.traffic span { display:flex; align-items:baseline; gap:6px; padding:4px 8px; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); font-size:var(--klh-text-sm); }
		.traffic strong { font-variant-numeric:tabular-nums; }
		.traffic small { color:var(--klh-dim); font:inherit; }
		details { color:var(--klh-ink-2); font-size:var(--klh-text-sm); margin-top:var(--klh-space-2); }
		summary { cursor:pointer; }
		summary:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		table { border-collapse:collapse; width:min(100%, 740px); margin-top:var(--klh-space-2); }
		th, td { text-align:left; padding:5px 12px 5px 0; border-bottom:1px solid var(--klh-edge-faint); }
		.live-controls { display:flex; align-items:center; gap:var(--klh-space-2); flex-wrap:wrap; margin:var(--klh-space-2) 0; }
		.live-controls label { font-size:var(--klh-text-sm); color:var(--klh-dim); }
		.live-controls input { min-inline-size:220px; max-inline-size:100%; background:var(--klh-surface); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:6px 8px; font:inherit; }
		.live-controls input:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.live-metrics { display:flex; gap:var(--klh-space-2); flex-wrap:wrap; margin-block:var(--klh-space-3); }
		.live-metrics div { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:6px 10px; min-inline-size:112px; }
		.live-metrics strong { display:block; font-variant-numeric:tabular-nums; font-size:var(--klh-text-lg); }
		.live-metrics small { color:var(--klh-dim); font-size:var(--klh-text-xs); }
		.live-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(240px,300px); gap:var(--klh-space-3); }
		.live-map { block-size:340px; overflow:auto; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); background:var(--klh-surface); }
		.live-map svg { inline-size:var(--map-width); min-inline-size:100%; font-size:12px; }
		.live-node { fill:var(--klh-surface); stroke:var(--klh-edge); stroke-width:1.5; cursor:pointer; }
		.live-node.selected { stroke:var(--klh-accent); stroke-width:2.5; }
		.live-node.endpoint { stroke-dasharray:4 3; }
		.live-edge { fill:none; stroke:var(--klh-info); stroke-width:1.5; cursor:pointer; }
		.live-edge.ledger { stroke:var(--klh-dim); stroke-dasharray:4 4; }
		.live-edge.selected { stroke:var(--klh-accent); stroke-width:3; }
		.live-edge.flow { stroke-dasharray:5 7; animation:route-flow 2.5s linear infinite; }
		:host([data-hidden]) .live-edge.flow { animation-play-state:paused; }
		@keyframes route-flow { to { stroke-dashoffset:-24; } }
		@media (prefers-reduced-motion:reduce) { .live-edge.flow { animation:none; stroke-dasharray:none; } }
		.live-label { fill:var(--klh-ink); font-weight:600; pointer-events:none; }
		.live-sub { fill:var(--klh-dim); font-size:10px; pointer-events:none; }
		.live-hit { fill:none; stroke:transparent; stroke-width:14; cursor:pointer; }
		.live-item:focus-visible { outline:none; }
		.live-item:focus-visible .live-node, .live-item:focus-visible .live-edge { stroke:var(--klh-accent); stroke-width:3; }
		.live-item.dimmed { opacity:.35; }
		.inspector { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:var(--klh-space-2); block-size:340px; box-sizing:border-box; overflow:auto; }
		.inspector h3 { margin-block:0 var(--klh-space-2); }
		.inspector dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; font-size:var(--klh-text-sm); margin:0; }
		.inspector dt { color:var(--klh-dim); }
		.inspector dd { margin:0; overflow-wrap:anywhere; }
		.trace-list { padding-inline-start:18px; font-size:var(--klh-text-xs); overflow-wrap:anywhere; }
		.edge-list { display:grid; gap:4px; margin-block:var(--klh-space-2); }
		.edge-list button { margin:0; text-align:left; }
		.coverage { color:var(--klh-dim); font-size:var(--klh-text-xs); line-height:1.4; }
		@media (max-width:760px) { .live-layout { grid-template-columns:minmax(0,1fr); } .inspector { block-size:auto; min-block-size:150px; max-block-size:340px; } }
	`;
	constructor() {
		super();
		this.topology = null;
		this.error = "";
		this.networkIssue = "";
		this.selectedId = null;
		this.expandedHubs = new Set();
		this.query = "";
		this.pageVisible = !document.hidden;
		this.onVisibility = () => {
			this.pageVisible = !document.hidden;
			this.toggleAttribute("data-hidden", !this.pageVisible);
		};
	}
	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("visibilitychange", this.onVisibility);
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 10_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		document.removeEventListener("visibilitychange", this.onVisibility);
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
				inventoryResponse,
			] = await Promise.all([
				...["/api/status", "/api/remotes", "/api/supervisor"].map((url) =>
					fetch(readApi(url), { signal: controller.signal, cache: "no-store" }),
				),
				fetch(readApi("/api/network"), {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
				fetch(readApi("/api/model-access"), {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
				fetch(readApi("/api/topology-context"), {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
				fetch(readApi("/api/model-inventory"), {
					signal: controller.signal,
					cache: "no-store",
				}).catch(() => null),
			]);
			// W858.7.33: a 403 topology.scope_denied on the detail feeds
			// (supervisor doc, model inventory) must not kill the page — the
			// hub summaries still render; the inspector says "withheld".
			if (!statusResponse.ok || !remotesResponse.ok)
				throw new Error("A topology feed is unavailable");
			const [status, remotes, supervisor, network, access, context, inventory] =
				await Promise.all([
					statusResponse.json(),
					remotesResponse.json(),
					supervisorResponse.ok
						? supervisorResponse.json().catch(() => null)
						: null,
					networkResponse?.ok ? networkResponse.json().catch(() => null) : null,
					accessResponse?.ok ? accessResponse.json().catch(() => null) : null,
					contextResponse?.ok ? contextResponse.json().catch(() => null) : null,
					inventoryResponse?.ok
						? inventoryResponse.json().catch(() => null)
						: null,
				]);
			this.networkIssue =
				network?.ok && network.network?.ok
					? ""
					: "Buckle request feed unavailable";
			const detail = buildTopology(
				status,
				remotes,
				supervisor,
				Date.now(),
				network,
				access,
				context,
				inventory,
			);
			detail.inventoryWithheld = inventoryResponse
				? !inventoryResponse.ok
				: false;
			detail.supervisorWithheld = !supervisorResponse.ok;
			this.topology = detail;
			document.dispatchEvent(
				new CustomEvent("belt-topology-data", { detail: this.topology }),
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
	fitCardText(value, length = 31) {
		const label = String(value);
		return label.length > length ? `${label.slice(0, length - 1)}…` : label;
	}
	targetHint(hosts) {
		if (!hosts?.length) return "source unspecified";
		return hosts.every((host) =>
			["127.0.0.1", "localhost", "::1"].includes(host),
		)
			? "hub local target"
			: "network target";
	}
	toggleHub(name) {
		const expanded = new Set(this.expandedHubs);
		if (expanded.has(name)) expanded.delete(name);
		else expanded.add(name);
		this.expandedHubs = expanded;
	}
	onToggleHubKey(event, name) {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		this.toggleHub(name);
	}
	edge(path, link) {
		const description =
			link.evidence === "observed"
				? link.source === "hub Buckle ledger"
					? `${link.successes15 ?? 0} succeeded · ${link.failures15 ?? 0} failed past 15 minutes · ${link.hub} Buckle ledger`
					: `${link.requests15} local Buckle requests · hop not verified by the trace topology`
				: link.evidence === "probe"
					? `Hub reachability probe · ${link.source}`
					: `Configured path · ${link.source}`;
		return svg`<g><title>${description}</title><path class=${`edge ${link.evidence === "observed" ? "observed" : ""}`} d=${path} stroke-width="1.5"></path></g>`;
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
		gatewayModels = null,
		gatewayModelTargets = {},
		hubKey = null,
		gatewayModelAliases = {},
		gatewayRouteCount = 0,
		gatewayUnresolvedRoutes = [],
		gatewayModelCosts = {},
		services = [],
		gatewayModelPorts = {},
		beltModels = [],
	) {
		const configuredAliases = new Set([
			...(gatewayModels ?? []),
			...Object.values(gatewayModelAliases).flat(),
		]);
		const exposed = hubKey
			? [
					...(gatewayModels ?? []).map((name) => ({
						name,
						source: beltModels.includes(name)
							? "Belt live catalog · inference unverified"
							: this.targetHint(gatewayModelTargets[name]),
						targets: gatewayModelTargets[name] ?? [],
						routes: gatewayModelAliases[name] ?? [],
						state: "unknown",
						usage15: null,
						price: gatewayModelCosts[name],
						ports: gatewayModelPorts[name] ?? [],
					})),
					...models
						.filter((item) => !configuredAliases.has(item.model))
						.map((item) => ({
							name: item.model,
							source: beltModels.includes(item.model)
								? "Belt live catalog · inference unverified"
								: "probe · origin unknown",
							targets: [],
							routes: [],
							state: item.state,
							usage15: Number.isFinite(item.requests15)
								? item.requests15
								: null,
							ports: [],
						})),
				].sort(
					(a, b) =>
						(b.usage15 ?? -1) - (a.usage15 ?? -1) ||
						a.name.localeCompare(b.name),
				)
			: [];
		const expanded = hubKey && this.expandedHubs.has(hubKey);
		const visible = expanded ? exposed : exposed.slice(0, 2);
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
			${
				hubKey
					? svg`<g>
				<rect class="belt" x=${x + 12} y=${y + 86} width=${width - 24} height="22" rx="2"></rect>
				<g><title>${gatewayRouteCount} configured Buckle routes${gatewayUnresolvedRoutes.length ? ` · no model ID: ${gatewayUnresolvedRoutes.join(", ")}` : ""}. Route targets are configured, not verified live. The full provider catalogs are in Fleet model inventory.</title><text class="title" x=${x + 23} y=${y + 102}>Buckle route targets · ${exposed.length}</text></g>
				${
					visible.length
						? visible.map((item, index) => {
								const column = index % 2;
								const row = Math.floor(index / 2);
								const itemX = x + 23 + column * 124;
								const itemY = y + 125 + row * 40;
								return svg`<g><title>${item.name} · ${item.source} · ${costDetail(item.price)}${item.targets.length ? ` · targets: ${item.targets.join(", ")}` : ""}${item.routes.length ? ` · Buckle routes: ${item.routes.join(", ")}` : ""}</title>
						<circle cx=${itemX} cy=${itemY} r="3" fill=${colour(item.state)}></circle>
						<text class="title" x=${itemX + 9} y=${itemY + 4}>${this.shortModel(item.name, 16)}</text>
					<text class="meta" x=${itemX + 9} y=${itemY + 18}>${this.shortModel(`${beltModels.includes(item.name) ? "Belt · " : item.ports.length === 1 ? `:${item.ports[0]} · ` : ""}${costCaption(item.price)}`, 19)}</text>
					</g>`;
							})
						: svg`<text class="meta" x=${x + 23} y=${y + 132}>No model inventory reported</text>`
				}
				${
					exposed.length > 2
						? svg`<g class="model-toggle-group" role="button" tabindex="0" aria-expanded=${expanded ? "true" : "false"} aria-label=${`${expanded ? "Show fewer" : `Show all ${exposed.length}`} models on ${title}`} @click=${() => this.toggleHub(hubKey)} @keydown=${(event) => this.onToggleHubKey(event, hubKey)}>
					<rect class="model-toggle-hit" x=${x + 18} y=${y + 151 + (Math.ceil(visible.length / 2) - 1) * 40} width=${width - 36} height="25"></rect>
					<text class="model-toggle" x=${x + 23} y=${y + 171 + (Math.ceil(visible.length / 2) - 1) * 40}>${expanded ? "Show fewer ↑" : `Show all ${exposed.length} ↓`}</text>
				</g>`
						: ""
				}
			</g>`
					: svg`
			<rect class="belt" x=${x + 12} y=${y + 86} width=${width - 24} height="22" rx="2"></rect>
			<text class="title" x=${x + 23} y=${y + 102}>${local ? "Belt local models" : "Reported models"} · ${models.length}${local ? " · API rate n/a" : ""}</text>
			${
				models.length
					? models.map((item, index) => {
							const column = local ? index % 2 : 0;
							const row = local ? Math.floor(index / 2) : index;
							const itemX = x + 21 + column * 176;
							const itemY = y + 125 + row * (local ? 41 : 35);
							return svg`<g><title>${item.model} · ${local ? "locally run; no posted API token rate" : "price unknown; probe origin unverified"}</title>
								<circle cx=${itemX} cy=${itemY} r="3" fill=${colour(item.state)}></circle>
								<text class="title" x=${itemX + 10} y=${itemY + 4}>${local ? `${item.port === 8912 ? "Kev" : item.role} · ${item.label}` : this.shortModel(item.model, 23)}</text>
								<text class="meta endpoint" x=${itemX + 10} y=${itemY + 18}>${local ? this.shortModel(item.model, 20) : beltModels.includes(item.model) ? "Belt live catalog" : "source unverified"}</text>
								${local ? svg`<text class="meta endpoint" x=${itemX + 10} y=${itemY + 31}>${item.load5m === null ? "Belt load unreported" : `${item.load5m} Belt req/5m`}</text>` : ""}
							</g>`;
						})
					: svg`<text class="meta" x=${x + 22} y=${y + 132}>No model inventory reported</text>`
			}`
			}
			${
				hubKey && services.length
					? svg`<g>${services.map((service, index) => {
							const serviceY =
								y + height - 16 - (services.length - 1 - index) * 28;
							return svg`<g><title>${service.name} · :${service.port} · ${service.roles.join(", ")} · ${service.state} probe</title><circle cx=${x + 23} cy=${serviceY - 4} r="3" fill=${colour(service.state)}></circle><text class="meta" x=${x + 33} y=${serviceY}>${service.name} · ${service.roles.join(", ")} · :${service.port}</text></g>`;
						})}</g>`
					: ""
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
	cloud(x, y, width, item, link, viaHub = null, routeConfigured = true) {
		const visible = viaHub ? [] : item.models.slice(0, 1);
		const hubRequest = item.hubRequest;
		// W1040: outside-process inference probe verdict — green only for
		// verified usable inference; every other state reads its own label.
		const probe = item.inference ?? { state: "untested" };
		const when = () =>
			age(new Date(probe.checkedAt ?? Date.now()).toISOString());
		const probeLabel =
			{
				ok: `Inference OK · ${probe.latencyMs ?? "?"}ms · ${when()}`,
				billing: "Billing blocked (429)",
				quota: "Quota exhausted (429)",
				auth: "Auth failed",
				failed: probe.httpStatus
					? `Probe failed (HTTP ${probe.httpStatus})`
					: "Probe failed (transport death)",
				stale: `Probe stale · checked ${when()}`,
				untested: "Inference untested",
			}[probe.state] ?? "Inference untested";
		const probeInk =
			{
				ok: "var(--klh-ok-ink)",
				billing: "var(--klh-accent)",
				quota: "var(--klh-accent)",
				auth: "var(--klh-danger)",
				failed: "var(--klh-danger)",
				stale: "var(--klh-dim)",
				untested: "var(--klh-dim)",
			}[probe.state] ?? "var(--klh-dim)";
		const status = hubRequest
			? `${hubRequest.successes15} succeeded · ${hubRequest.failures15} failed /15m`
			: viaHub && !routeConfigured
				? "Declared hub provider · upstream hop unverified"
				: Number.isFinite(link?.requests15)
					? `${link.requests15} successful /15m · ${link.failures15 ?? "—"} target failures`
					: item.state === "unconfigured"
						? viaHub
							? "Hub route configured · traffic unobserved"
							: "Direct API key not configured"
						: viaHub
							? "Provider upstream · gateway path configured"
							: item.kind === "copilot"
								? `${item.catalog?.models?.length ?? 0} selectable · ${item.catalog?.state ?? "catalog unknown"}`
								: `${item.reachable}/${item.endpoints} probes · traffic unavailable`;
		return svg`<g><rect class="cloud" x=${x} y=${y} width=${width} height="86" rx="3"></rect>
			<circle cx=${x + 14} cy=${y + 18} r="3.5" fill=${probeInk}><title>${probeLabel}</title></circle>
			<text class="title" x=${x + 25} y=${y + 22}>${item.name}</text>
			<g><title>${probeLabel}</title><text class="meta endpoint" x=${x + 12} y=${y + 39}>${this.fitCardText(probeLabel)}</text></g>
			<g><title>${status}${hubRequest ? ` · last HTTP ${hubRequest.lastStatus} at ${localTime(hubRequest.lastAt)} from hub Buckle ledger` : link ? ` · ${link.source} · last evidence ${localTime(link.lastSeen)}` : ""}</title><text class="meta endpoint" x=${x + 12} y=${y + 58}>${this.fitCardText(status)}</text></g>
			${viaHub ? svg`<g><title>${routeConfigured ? `Configured hub routes shown under ${viaHub}` : `Hub model routes shown under ${viaHub}`}</title><text class="meta" x=${x + 12} y=${y + 58}>${this.fitCardText(`Models via ${viaHub}`)}</text></g>` : visible.length ? visible.map((model, index) => svg`<g><title>${model}</title><text class="meta" x=${x + 12} y=${y + 74 + index * 16}>${this.shortModel(model, 35)}</text></g>`) : svg`<text class="meta" x=${x + 12} y=${y + 74}>Model inventory unavailable</text>`}
			${!viaHub && item.models.length > 1 ? svg`<a href="#modelaccess"><text class="meta" x=${x + 158} y=${y + 75}>+${item.models.length - 1} in model access</text></a>` : ""}
		</g>`;
	}
	activate(event, id) {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		this.selectedId = id;
	}
	onSearch(event) {
		this.query = event.target.value;
		const graph = this.topology?.observedGraph;
		const term = this.query.trim().toLowerCase();
		if (!graph || !term) return;
		const node = observedGraphLayout(graph).nodes.find((item) =>
			`${item.label} ${item.id}`.toLowerCase().includes(term),
		);
		if (!node) return;
		this.updateComplete.then(() => {
			const map = this.renderRoot.querySelector(".live-map");
			const svgElement = map?.querySelector("svg");
			if (!map || !svgElement) return;
			const scale =
				svgElement.clientWidth / Math.max(1, svgElement.viewBox.baseVal.width);
			map.scrollLeft = Math.max(0, node.x * scale - map.clientWidth / 3);
			map.scrollTop = Math.max(0, node.y * scale - map.clientHeight / 3);
		});
	}
	selectedTraces(graph, selectedNode, selectedEdge) {
		const from = selectedEdge?.from?.replace(/^hub:/, "");
		const to = selectedEdge?.to?.replace(/^hub:/, "");
		return graph.traces
			.filter((trace) => {
				if (!Array.isArray(trace.hops)) return false;
				if (selectedEdge) {
					if (!selectedEdge.to.startsWith("hub:")) return false;
					return trace.hops.some(
						(hop, index) => hop === from && trace.hops[index + 1] === to,
					);
				}
				return selectedNode?.kind === "hub"
					? trace.hops.includes(selectedNode.id.replace(/^hub:/, ""))
					: false;
			})
			.slice(0, 5);
	}
	renderObserved(data) {
		const graph = data.observedGraph;
		const layout = observedGraphLayout(graph);
		const positions = new Map(layout.nodes.map((node) => [node.id, node]));
		const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
		const selectedNode = graph.nodes.find(
			(node) => node.id === this.selectedId,
		);
		const selectedEdge = graph.edges.find(
			(edge) => edge.id === this.selectedId,
		);
		const selected = selectedNode || selectedEdge;
		const traces = this.selectedTraces(graph, selectedNode, selectedEdge);
		const term = this.query.trim().toLowerCase();
		const matching = (node) =>
			!term || `${node.label} ${node.id}`.toLowerCase().includes(term);
		const windowSeconds =
			(Date.parse(graph.observedAt) - Date.parse(graph.windowStart)) / 1000;
		const outputRate =
			Number.isFinite(graph.totals.outputTokens) && windowSeconds > 0
				? (graph.totals.outputTokens / windowSeconds).toFixed(2)
				: "unreported";
		const inventory =
			selectedNode?.kind === "hub"
				? data.machines.find(
						(item) =>
							item.name.toLowerCase() === selectedNode.label.toLowerCase(),
					)
				: null;
		return html`<section aria-label="Belt connection map">
			<div class="heading"><h2>Network · observed routes</h2><button type="button" @click=${this.refresh}>Refresh map</button></div>
			<p role="status">${this.error || `${graph.nodes.length} observed hubs and endpoints · ${graph.edges.length} measured paths · updated ${age(graph.observedAt)}`}</p>
			<div class="live-metrics" aria-label="Observed network totals for the past 15 minutes">
				<div><strong>${measure(graph.totals.requests)}</strong><small>requests · 15m</small></div>
				<div><strong>${measure(graph.totals.failed)}</strong><small>failed · 15m</small></div>
				<div><strong>${measure(graph.totals.active)}</strong><small>active requests</small></div>
				<div><strong>${outputRate}</strong><small>avg reported output tok/s · local origin</small></div>
			</div>
			<div class="live-controls"><label for="topology-search">Find hub or endpoint</label><input id="topology-search" type="search" .value=${this.query} @input=${this.onSearch} placeholder="Name, host, or port" aria-controls="topology-map" />
				${
					this.selectedId
						? html`<button type="button" @click=${() => {
								this.selectedId = null;
							}}>Clear selection</button>`
						: ""
				}
			</div>
			<div class="live-layout">
				<div id="topology-map" class="live-map" style=${`--map-width:${layout.width}px`}><svg class="live-svg" viewBox=${`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Observed network routes. Use Tab to focus a hub, endpoint, or connection; press Enter to inspect it.">
					${graph.edges.map((edge) => {
						const from = positions.get(edge.from);
						const to = positions.get(edge.to);
						if (!from || !to) return "";
						const path = `M${from.x + 190} ${from.y + 26} L${to.x} ${to.y + 26}`;
						const flow =
							edge.evidence === "trace" && edge.fresh && edge.requests > 0;
						return svg`<g class="live-item" role="button" tabindex="0" aria-label=${`${labels.get(edge.from)} to ${labels.get(edge.to)}, ${edge.requests} observed requests in 15 minutes, ${edge.evidence} evidence, last seen ${age(edge.lastSeenAt)}`} @click=${() => {
							this.selectedId = edge.id;
						}} @keydown=${(event) => this.activate(event, edge.id)}>
							<path class=${`live-edge ${edge.evidence === "ledger" ? "ledger" : ""} ${flow ? "flow" : ""} ${this.selectedId === edge.id ? "selected" : ""}`} d=${path} stroke-width=${Math.min(4, 1 + Math.log10(1 + edge.requests))}></path><path class="live-hit" d=${path}></path>
						</g>`;
					})}
					${layout.nodes.map(
						(
							node,
						) => svg`<g class=${`live-item ${matching(node) ? "" : "dimmed"}`} role="button" tabindex="0" aria-label=${`${node.kind === "hub" ? "Hub" : "Observed endpoint"} ${node.label}, last seen ${age(node.lastSeenAt)}`} @click=${() => {
							this.selectedId = node.id;
						}} @keydown=${(event) => this.activate(event, node.id)}>
						<rect class=${`live-node ${node.kind === "endpoint" ? "endpoint" : ""} ${this.selectedId === node.id ? "selected" : ""}`} x=${node.x} y=${node.y} width="190" height="52" rx="4"></rect>
						<text class="live-label" x=${node.x + 10} y=${node.y + 22}>${node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label}</text>
						<text class="live-sub" x=${node.x + 10} y=${node.y + 39}>${node.kind === "hub" ? "hub" : `${node.targetKind} endpoint`} · ${age(node.lastSeenAt)}</text>
					</g>`,
					)}
				</svg></div>
				<aside class="inspector" aria-live="polite" aria-label="Selected network item">
					${
						selected
							? html`<h3>${selectedNode ? selectedNode.label : `${labels.get(selectedEdge.from)} → ${labels.get(selectedEdge.to)}`}</h3>
						<dl>
							<dt>Type</dt><dd>${selectedNode ? (selectedNode.kind === "endpoint" ? `${selectedNode.targetKind} endpoint` : "Observed hub") : `${selectedEdge.evidence} connection`}</dd>
							<dt>Last observed</dt><dd>${localTime(selected.lastSeenAt)} · ${age(selected.lastSeenAt)}</dd>
							<dt>Requests</dt><dd>${selectedEdge ? `${measure(selectedEdge.requests)} / 15m` : "See connected paths"}</dd>
							<dt>Failures / active requests</dt><dd>${selectedEdge ? `${measure(selectedEdge.failed)} / ${measure(selectedEdge.active)}` : "See connected paths"}</dd>
							<dt>Input / output tokens</dt><dd>${selectedEdge ? `${measure(selectedEdge.inputTokens)} / ${measure(selectedEdge.outputTokens)}` : "See connected paths"}</dd>
							<dt>Measurement</dt><dd>${selectedEdge ? `${selectedEdge.coverage?.source === "local-origin-ledger" ? "local origin ledger" : selectedEdge.coverage?.source === "projection" ? "hub projection" : "source unreported"} · ${measure(selectedEdge.coverage?.usageBearingRequests)} requests with token usage` : "See connected paths"}</dd>
						</dl>
						${
							selectedNode
								? html`<div class="edge-list"><h3>Connected paths</h3>${graph.edges
										.filter(
											(edge) =>
												edge.from === selectedNode.id ||
												edge.to === selectedNode.id,
										)
										.map(
											(edge) =>
												html`<button type="button" @click=${() => {
													this.selectedId = edge.id;
												}}>${labels.get(edge.from)} → ${labels.get(edge.to)} · ${measure(edge.requests)} /15m</button>`,
										)}</div>`
								: ""
						}
						${inventory?.models?.length ? html`<details><summary>Probe model inventory · ${inventory.models.length}</summary><p>Inventory is separate from route evidence.</p><ul>${inventory.models.map((model) => html`<li>${model}</li>`)}</ul></details>` : ""}
						<h3>Joined traces</h3>${traces.length ? html`<ol class="trace-list">${traces.map((trace) => html`<li><code>${trace.id.slice(0, 12)}…</code> · ${trace.hops.join(" → ")} · ${trace.complete ? "complete" : "partial"}</li>`)}</ol>` : html`<p>No joined trace for this selection.</p>`}
					`
							: html`<h3>Inspect a route</h3><p>Select a hub, endpoint, or connection in the map. Keyboard users can also use the connection list below.</p>`
					}
				</aside>
			</div>
			<p class="coverage">Solid paths join recorded hub hops. Dashed paths end at an observed local-ledger endpoint; they may describe the same request and are not additional estate requests. Subtle motion means a trace-backed hop was seen in the past minute, not that a lane is still active.</p>
			<p class="coverage">${graph.coverage.projectionAvailable ? "Hub projection available" : "Hub projection unavailable"} · ${graph.coverage.ledgerAvailable ? "local ledger available" : "local ledger unavailable"} · ${measure(graph.coverage.tracesReturned)} of ${measure(graph.coverage.tracesTotal)} traces returned${graph.coverage.projectionTruncated ? " · projection truncated" : ""} · token usage: ${graph.coverage.tokensScope === "local-origin-ledger" ? `${measure(graph.coverage.usageBearingOrigins)} local origins reported` : "unreported"}. Endpoint targets are kept separate from provider identity until a catalog joins them.</p>
			<details><summary>Accessible connection list · ${graph.edges.length}</summary><table><thead><tr><th scope="col">Connection</th><th scope="col">Requests / 15m</th><th scope="col">Evidence</th><th scope="col">Last observed</th></tr></thead><tbody>${graph.edges.map(
				(edge) =>
					html`<tr><td><button type="button" @click=${() => {
						this.selectedId = edge.id;
					}}>${labels.get(edge.from)} → ${labels.get(edge.to)}</button></td><td>${measure(edge.requests)}</td><td>${edge.evidence}</td><td>${localTime(edge.lastSeenAt)}</td></tr>`,
			)}</tbody></table></details>
		</section>`;
	}
	render() {
		const data = this.topology;
		const observed = data?.observedGraph;
		const machines = data?.machines ?? [];
		const hubs = [...(data?.hubs ?? [])].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		const observedHubFor = (key) =>
			(data?.hubProviderLinks ?? [])
				.filter((link) => link.provider === key)
				.map((link) => link.hub.toLowerCase());
		const observedLinkFor = (key, hubName) =>
			(data?.hubProviderLinks ?? []).find(
				(link) =>
					link.provider === key &&
					link.hub.toLowerCase() === hubName.toLowerCase(),
			);
		const hubForProvider = (key) =>
			hubs.filter(
				(hub) =>
					observedHubFor(key).includes(hub.name.toLowerCase()) ||
					hub.providerKeys?.includes(key) ||
					hub.providerIntents?.includes(key),
			);
		const hubForProviderSorted = (key) => {
			const observed = observedHubFor(key);
			return hubForProvider(key).sort(
				(a, b) =>
					Number(observed.includes(b.name.toLowerCase())) -
						Number(observed.includes(a.name.toLowerCase())) ||
					Number(Boolean(b.providerKeys?.includes(key))) -
						Number(Boolean(a.providerKeys?.includes(key))) ||
					(b.providerCounts?.[key] ?? 0) - (a.providerCounts?.[key] ?? 0),
			)[0];
		};
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
			const remoteModels = (inventory?.models ?? [])
				.filter((model) => !item.gatewayModels?.includes(model))
				.map((model) => ({
					model,
					state: inventory.state,
				}));
			const exposedCount =
				(item.gatewayModels?.length ?? 0) + remoteModels.length;
			const visibleCount = this.expandedHubs.has(item.name)
				? exposedCount
				: Math.min(2, exposedCount);
			const card = {
				...item,
				y: hubY,
				height:
					exposedCount > 2
						? 195 + Math.max(0, Math.ceil(visibleCount / 2) - 1) * 40
						: exposedCount > 0
							? 162
							: 150,
				models: remoteModels,
				services: inventory?.services ?? [],
			};
			card.height += card.services.length * 28;
			const pairedProviders = clouds.filter(
				(provider) => hubForProviderSorted(provider.key)?.name === item.name,
			);
			hubY += Math.max(card.height, pairedProviders.length * 94 - 8) + 12;
			return card;
		});
		const localHeight = Math.max(198, 168 + Math.ceil(models.length / 2) * 41);
		let unpairedY = hubY;
		const cloudCards = clouds.map((item) => {
			const pairedHub = hubCards.find(
				(hub) => hubForProviderSorted(item.key)?.name === hub.name,
			);
			if (pairedHub) {
				const preceding = clouds.filter(
					(provider) =>
						provider.key !== item.key &&
						clouds.indexOf(provider) < clouds.indexOf(item) &&
						hubForProviderSorted(provider.key)?.name === pairedHub.name,
				).length;
				return { ...item, y: pairedHub.y + preceding * 94 };
			}
			const card = { ...item, y: unpairedY };
			unpairedY += 94;
			return card;
		});
		const height = Math.max(440, 65 + localHeight, hubY, unpairedY);
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
			<p class="coverage">Solid links are measured routes; dashed links are probes or configured paths.${observed ? ` ${measure(observed.totals.requests)} requests and ${measure(observed.totals.failed)} failures observed in the past 15 minutes.` : " Trace-backed route data is unavailable."}</p>
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
					if (hubForProviderSorted(item.key) && link?.evidence !== "observed")
						return "";
					return link
						? this.edge(`M386 113 H403 V51 H742 V${item.y + 42} H770`, link)
						: "";
				})}
				${hubCards.flatMap((hub) =>
					cloudCards
						.filter(
							(item) =>
								Boolean(observedLinkFor(item.key, hub.name)) ||
								(hubForProviderSorted(item.key)?.name === hub.name &&
									(hub.providerKeys?.includes(item.key) ||
										hub.providerIntents?.includes(item.key))),
						)
						.map((item) => {
							const observed = observedLinkFor(item.key, hub.name);
							return this.edge(
								`M705 ${hub.y + 54} H738 V${item.y + 42} H770`,
								observed
									? { ...observed, hub: hub.displayName || hub.name }
									: {
											evidence: "configured",
											source: hub.providerKeys?.includes(item.key)
												? `${hub.displayName || hub.name} configured upstream`
												: `${hub.displayName || hub.name} declared provider intent`,
										},
							);
						}),
				)}
				${this.machine(16, 65, 370, localHeight, "This Mac", `local spoke · :4101 · ${data.gateway === "unknown" ? "unobserved" : data.gateway}`, data.gateway, models, true, data.localConsoleUrl, data.work)}
		${hubCards.map((item) => this.machine(430, item.y, 275, item.height, item.displayName || item.name, `:${item.port} · ${item.state} probe`, item.state, item.models, false, item.consoleUrl, null, item.gatewayModels, item.gatewayModelTargets, item.name, item.gatewayModelAliases, item.gatewayRouteCount, item.gatewayUnresolvedRoutes, item.gatewayModelCosts, item.services, item.gatewayModelPorts, item.beltModels))}
					${cloudCards.map((item) =>
						this.cloud(
							770,
							item.y,
							275,
							item,
							data.links.find((link) => link.target === `provider:${item.key}`),
							hubForProviderSorted(item.key)?.displayName ||
								hubForProviderSorted(item.key)?.name ||
								null,
							hubForProviderSorted(item.key)?.providerKeys?.includes(
								item.key,
							) ?? false,
						),
					)}
			</svg></div>`
					: html`<div class="map" aria-busy="true"><p>Loading map…</p></div>`
			}
		</section>`;
	}
}

customElements.define("belt-topology", BeltTopology);

class BeltTopologyDetails extends LitElement {
	static properties = { topology: { state: true } };
	static styles = BeltTopology.styles;
	constructor() {
		super();
		this.topology = null;
		this.onData = (event) => {
			this.topology = event.detail;
		};
	}
	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("belt-topology-data", this.onData);
		this.topology = document.querySelector("belt-topology")?.topology ?? null;
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("belt-topology-data", this.onData);
	}
	render() {
		const data = this.topology;
		const observed = data?.observedGraph;
		const audit = data?.audit15;
		const hubDisplay = (name) =>
			data?.hubs?.find(
				(hub) => hub.name.toLowerCase() === String(name).toLowerCase(),
			)?.displayName ?? name;
		return html`<section aria-label="Network route details">
			<div class="heading"><h2>Network route details</h2></div>
			<p class="legend">Solid blue: observed successful routes in the past 15 minutes. Dashed: configured provider path or hub probe. Hub route counts use its observation feed. Local model loads count Belt router calls.</p>
			${
				observed
					? html`<details><summary>Observed route details · ${observed.edges.length} paths · ${measure(observed.totals.requests)} requests / 15m</summary>
				<p class="coverage">Trace-backed paths are shown here alongside the inventory. An endpoint is only named as a provider when its identity is verified.</p>
				<table><thead><tr><th scope="col">Route</th><th scope="col">Requests</th><th scope="col">Failed</th><th scope="col">Evidence</th></tr></thead><tbody>${observed.edges.map((edge) => html`<tr><td>${observed.nodes.find((node) => node.id === edge.from)?.label ?? edge.from} → ${observed.nodes.find((node) => node.id === edge.to)?.label ?? edge.to}</td><td>${measure(edge.requests)}</td><td>${measure(edge.failed)}</td><td>${edge.evidence}</td></tr>`)}</tbody></table>
			</details>`
					: ""
			}
			<details><summary>Connection data · ${(data?.links?.length ?? 0) + (data?.hubProviderLinks?.length ?? 0)} paths</summary>
				<table><thead><tr><th scope="col">Target</th><th scope="col">Path</th><th scope="col">Successful / 15m</th><th scope="col">Target failures / 15m</th><th scope="col">Source</th><th scope="col">Last evidence</th></tr></thead>
				<tbody>${(data?.links ?? []).concat(data?.hubProviderLinks ?? []).map((link) => html`<tr><td>${link.hub ? `${hubDisplay(link.hub)} → ${link.provider}` : link.target.replace(/^hub:|^provider:/, "")}</td><td>${link.evidence}</td><td>${link.hub ? link.successes15 : (link.requests15 ?? "—")}</td><td>${link.hub ? link.failures15 : (link.failures15 ?? "—")}</td><td>${link.source}</td><td title=${link.lastSeen ? new Date(link.lastSeen).toISOString() : "No observed route"}>${localTime(link.lastSeen)}</td></tr>`)}</tbody></table>
				${audit?.unattributedFailed ? html`<p>${audit.unattributedFailed} failed requests have no target attribution in the Buckle ledger.</p>` : ""}
				${audit?.failures?.length ? html`<h3>Failed Buckle attempts · recorded target</h3><table><thead><tr><th scope="col">Target</th><th scope="col">Failures / 15m</th><th scope="col">Last failure</th></tr></thead><tbody>${audit.failures.map((row) => html`<tr><td>${row.host ? `${row.kind} · ${row.host}${row.port ? `:${row.port}` : ""}` : "Target unrecorded"}</td><td>${row.count}</td><td title=${row.lastAt}>${localTime(row.lastAt)}</td></tr>`)}</tbody></table>` : ""}
			</details>
		</section>`;
	}
}

customElements.define("belt-topology-details", BeltTopologyDetails);

class BeltModelInventory extends LitElement {
	static properties = {
		inventory: { state: true },
		error: { state: true },
		query: { state: true },
		includeCatalog: { state: true },
	};
	static styles = css`
		:host { display:block; margin-block:var(--klh-space-3); }
		details { border:1px solid var(--klh-edge); border-radius:var(--klh-radius); padding:var(--klh-space-2); }
		summary { cursor:pointer; color:var(--klh-ink); }
		p { color:var(--klh-dim); margin:var(--klh-space-2) 0; }
		.controls { display:flex; align-items:center; flex-wrap:wrap; gap:var(--klh-space-3); margin:var(--klh-space-3) 0; }
		.controls input[type="search"] { min-inline-size:24ch; padding:5px 8px; border:1px solid var(--klh-edge); background:var(--klh-bg); color:var(--klh-ink); font:inherit; }
		.controls label { color:var(--klh-dim); }
		.table-wrap { overflow:auto; max-block-size:420px; }
		table { inline-size:100%; border-collapse:collapse; font-size:var(--klh-text-sm); }
		th, td { border-block-end:1px solid var(--klh-edge); padding:6px 10px; text-align:start; vertical-align:top; }
		th { position:sticky; inset-block-start:0; background:var(--klh-bg); }
		.evidence { color:var(--klh-dim); }
	`;
	constructor() {
		super();
		this.inventory = null;
		this.error = "";
		this.query = "";
		this.includeCatalog = false;
		this.timer = null;
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 300_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
	}
	async refresh() {
		try {
			const response = await fetch(readApi("/api/model-inventory"), {
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			this.inventory = await response.json();
			this.error = "";
		} catch (error) {
			this.error = String(error?.message ?? error);
		}
	}
	render() {
		const models = this.inventory?.models ?? [];
		const exposed = models.filter((model) =>
			model.exposures?.some((exposure) => exposure.kind !== "provider"),
		);
		const visible = (this.includeCatalog ? models : exposed).filter((model) => {
			const needle = this.query.trim().toLocaleLowerCase();
			return (
				!needle ||
				`${model.id} ${model.provider ?? ""} ${model.exposures.map((row) => row.owner).join(" ")}`
					.toLocaleLowerCase()
					.includes(needle)
			);
		});
		return html`<details>
			<summary>Fleet model inventory · ${models.length} provider/model identities · ${exposed.length} exposed locally or through hubs</summary>
			<p>Inventory combines Belt probes, Buckle route configuration and provider catalogs. A configured route or catalog entry does not prove successful inference.</p>
			${this.error ? html`<p role="status">Inventory unavailable · ${this.error}</p>` : ""}
			<div class="controls"><input type="search" aria-label="Find model" placeholder="Find model or provider" .value=${this.query} @input=${(
				event,
			) => {
				this.query = event.target.value;
			}}>
			<label><input type="checkbox" .checked=${this.includeCatalog} @change=${(
				event,
			) => {
				this.includeCatalog = event.target.checked;
			}}> Include provider catalogs</label><span>${visible.length} shown</span></div>
			<div class="table-wrap"><table><thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Exposure and route</th><th scope="col">Evidence</th></tr></thead>
			<tbody>${visible.map(
				(model) => html`<tr>
				<td>${model.id}</td><td>${model.provider ?? "unattributed"}</td>
				<td>${model.exposures.map((row) => html`<div>${row.owner}${row.endpoint ? ` · ${row.endpoint}` : ""}${row.routes?.length ? ` · ${row.routes.join(", ")}` : ""}</div>`)}</td>
				<td class="evidence">${model.exposures.map((row) => html`<div title=${row.observedAt ?? "No live observation"}>${row.evidence} · ${row.state}${row.observedAt ? ` · ${localTime(row.observedAt)}` : ""}</div>`)}</td>
			</tr>`,
			)}</tbody></table></div>
		</details>`;
	}
}

customElements.define("belt-model-inventory", BeltModelInventory);
