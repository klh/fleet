/// <reference lib="dom" />
import { css, html, LitElement } from "lit";

type Page = "overview" | "status" | "settings" | "statistics";
type Model = { id: string };
type Snapshot = {
	hub: string;
	observedAt: string | null;
	topology: {
		hubs: Array<{ id: string; name: string; freshnessS: number }>;
		targets: Array<{ id: string; kind: string; host: string }>;
		edges: Array<{
			from: string;
			to: string;
			requests: number;
			failed: number;
			active: number;
		}>;
		totals: { requests: number; failed: number; active: number };
		coverage: { projectionAvailable: boolean; ledgerAvailable: boolean };
	} | null;
};
type Status = {
	service?: string;
	healthy?: boolean;
	port?: number;
	uptime_s?: number;
	requests?: { total?: number };
	last_error?: { message?: string } | null;
};

const pages: Array<{ id: Page; label: string; code: string }> = [
	{ id: "overview", label: "Overview", code: "01" },
	{ id: "status", label: "Status", code: "02" },
	{ id: "settings", label: "Settings", code: "03" },
	{ id: "statistics", label: "Statistics", code: "04" },
];

class BuckleConsole extends LitElement {
	static override properties = {
		page: { state: true },
		status: { state: true },
		snapshot: { state: true },
		models: { state: true },
		key: { state: true },
		message: { state: true },
		loading: { state: true },
	};

	declare page: Page;
	declare status: Status | null;
	declare snapshot: Snapshot | null;
	declare models: Model[];
	declare key: string;
	declare message: string;
	declare loading: boolean;
	private refreshTimer?: number;

	constructor() {
		super();
		this.page = "overview";
		this.status = null;
		this.snapshot = null;
		this.models = [];
		this.key = "";
		this.message = "";
		this.loading = false;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.key = sessionStorage.getItem("buckle.read-key") ?? "";
		void this.refresh();
		this.refreshTimer = window.setInterval(() => void this.refresh(), 30_000);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.clearInterval(this.refreshTimer);
	}

	private async refresh() {
		this.loading = true;
		try {
			const status = await fetch("/status", { cache: "no-store" });
			this.status = status.ok ? ((await status.json()) as Status) : null;
			const headers = this.key
				? { authorization: `Bearer ${this.key}` }
				: undefined;
			const [network, models] = await Promise.all([
				fetch("/console/data", { headers, cache: "no-store" }),
				fetch("/v1/models", { headers, cache: "no-store" }),
			]);
			if (network.ok) {
				this.snapshot = (await network.json()) as Snapshot;
				this.message = "";
			} else {
				this.snapshot = null;
				this.message =
					network.status === 401 || network.status === 403
						? "Enter a Buckle read key in Settings to see routes and models."
						: "Network observations are unavailable right now.";
			}
			this.models = models.ok
				? (((await models.json()) as { data?: Model[] }).data ?? [])
				: [];
		} catch {
			this.message = "Buckle could not be reached. Try refreshing.";
			this.snapshot = null;
		} finally {
			this.loading = false;
		}
	}

	private saveKey(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const input = form.elements.namedItem("readKey") as HTMLInputElement;
		this.key = input.value.trim();
		if (this.key) sessionStorage.setItem("buckle.read-key", this.key);
		else sessionStorage.removeItem("buckle.read-key");
		void this.refresh();
	}

	private switchPage(page: Page) {
		this.page = page;
	}

	private renderNav() {
		return html`<aside class="sidebar">
			<div class="brand"><span class="brand-mark">b</span><span>buckle</span></div>
			<div class="nav-caption">WORKSPACE</div>
			<nav aria-label="Buckle sections">
				${pages.map(
					(item) => html`<button
						type="button"
						class=${this.page === item.id ? "nav-item active" : "nav-item"}
						aria-current=${this.page === item.id ? "page" : "false"}
						@click=${() => this.switchPage(item.id)}
					><span class="nav-code">${item.code}</span>${item.label}</button>`,
				)}
			</nav>
			<div class="side-foot">
				<span class=${this.status?.healthy ? "dot good" : "dot"}></span>
				<span>${this.status?.healthy ? "Gateway responding" : "Status unavailable"}</span>
			</div>
		</aside>`;
	}

	private renderOverview() {
		const topology = this.snapshot?.topology;
		const hubs =
			topology?.hubs.filter((hub) => hub.name !== this.snapshot?.hub) ?? [];
		const targets = topology?.targets ?? [];
		const trafficFor = (id: string) =>
			topology?.edges
				.filter((edge) => edge.to === id || edge.from === id)
				.reduce((total, edge) => total + edge.requests, 0) ?? 0;
		const labelFor = (id: string) =>
			id === this.snapshot?.hub
				? `${id} · this installation`
				: (topology?.hubs.find((hub) => hub.id === id)?.name ??
					topology?.targets.find((target) => target.id === id)?.kind ??
					id);
		const edges = topology?.edges ?? [];
		return html`
			<div class="section-title"><h2>Network overview</h2><span>Observed paths · last 15 minutes</span></div>
			${this.message ? html`<div class="notice" role="status">${this.message}</div>` : ""}
			<div class="map" aria-label="Gateway network map">
				<section class="map-column">
					<h3>THIS INSTALLATION</h3>
					<div class="node local">
						<div class="node-title"><span class="dot good"></span><strong>${this.snapshot?.hub ?? "Buckle"}</strong></div>
						<p>Gateway · ${this.status?.port ? `port ${this.status.port}` : "port unknown"}</p>
						<div class="node-rule"></div>
						<span class="muted">${this.models.length} served models · ${topology?.totals.requests ?? "—"} observed requests</span>
					</div>
				</section>
				<section class="map-column">
					<h3>HUBS</h3>
					${
						hubs.length
							? hubs.map(
									(hub) => html`<div class="node">
									<div class="node-title"><span class="dot good"></span><strong>${hub.name}</strong></div>
									<p>Last observed ${Math.max(0, hub.freshnessS)}s ago</p>
									<p>${trafficFor(hub.id)} requests on observed paths</p>
								</div>`,
								)
							: html`<div class="empty-node">No peer hub observed in this window.</div>`
					}
				</section>
				<section class="map-column">
					<h3>UPSTREAM TARGETS</h3>
					${
						targets.length
							? targets.map(
									(target) => html`<div class="node">
									<div class="node-title"><span class="dot"></span><strong>${target.kind}</strong></div>
									<p class="truncate" title=${target.host}>${target.host}</p>
									<p>${trafficFor(target.id)} requests on observed paths</p>
								</div>`,
								)
							: html`<div class="empty-node">No upstream target observed in this window.</div>`
					}
				</section>
			</div>
			<div class="section-title lower"><h2>Observed routes</h2><span>Directed paths seen in this window</span></div>
			${
				edges.length
					? html`<div class="route-list">${edges.map(
							(
								edge,
							) => html`<div class="route-row" data-edge=${`${edge.from}->${edge.to}`}>
								<span class="route-link"><strong>${labelFor(edge.from)}</strong><span class="route-arrow">→</span><strong>${labelFor(edge.to)}</strong></span>
								<span class="route-counts">${edge.requests} requests · ${edge.failed} failed</span>
							</div>`,
						)}</div>`
					: html`<p class="muted">No request path observed yet in this window.</p>`
			}
			<div class="section-title lower"><h2>Served models</h2><span>From Buckle’s model catalog</span></div>
			${
				this.models.length
					? html`<div class="model-list">${this.models.map(
							(model) =>
								html`<div class="model-row"><span class="dot good"></span><span>${model.id}</span></div>`,
						)}</div>`
					: html`<p class="muted">No models visible. Add a read key in Settings if the gateway requires authentication.</p>`
			}
		`;
	}

	private renderStatus() {
		return html`<div class="section-title"><h2>Gateway status</h2><span>Live service telemetry</span></div>
			<div class="status-grid">
				<div class="stat"><span>Service</span><strong>${this.status?.service ?? "Unavailable"}</strong></div>
				<div class="stat"><span>Self-reported health</span><strong>${this.status?.healthy ? "Responding" : "Unavailable"}</strong></div>
				<div class="stat"><span>Uptime</span><strong>${this.status?.uptime_s == null ? "—" : `${Math.floor(this.status.uptime_s / 60)} min`}</strong></div>
				<div class="stat"><span>Requests since start</span><strong>${this.status?.requests?.total ?? "—"}</strong></div>
			</div>
			${
				this.status?.last_error
					? html`<div class="notice" role="status">Last reported error: ${this.status.last_error.message ?? "unknown"}</div>`
					: ""
			}
			<div class="section-title lower"><h2>Observations</h2></div>
			<p class="muted">${
				this.snapshot?.topology?.coverage.ledgerAvailable
					? "Local route ledger available."
					: "Local route ledger unavailable."
			}
				${
					this.snapshot?.topology?.coverage.projectionAvailable
						? "Hub projection available."
						: "Hub projection unavailable."
				}</p>`;
	}

	private renderSettings() {
		return html`<div class="section-title"><h2>Settings</h2><span>Access for this browser session</span></div>
			<div class="settings-card">
				<h3>Gateway access</h3>
				<p>Use a key with <code>buckle:proxy:READ_</code> to view the model catalog and observed routes. The key stays in this tab’s session storage.</p>
				<form @submit=${this.saveKey}>
					<label for="read-key">Read key</label>
					<div class="input-row"><input id="read-key" name="readKey" type="password" autocomplete="off" .value=${this.key} placeholder="bksk_…" /><button type="submit">Apply</button></div>
				</form>
				<div class="setting-line"><span>Gateway URL</span><code>${location.origin}</code></div>
				<div class="setting-line"><span>Hub identity</span><code>${this.snapshot?.hub ?? "Unavailable"}</code></div>
			</div>`;
	}

	override render() {
		const label =
			pages.find((item) => item.id === this.page)?.label ?? "Overview";
		return html`<div class="shell">
			${this.renderNav()}
			<main>
				<header class="top">
					<div><div class="eyebrow">BUCKLE / CONSOLE</div><h1>${label}</h1><p>One place to see this gateway and the routes it serves.</p></div>
					<button class="refresh" type="button" ?disabled=${this.loading} @click=${this.refresh}>${this.loading ? "Refreshing…" : "Refresh"}</button>
				</header>
				${
					this.page === "overview"
						? this.renderOverview()
						: this.page === "status"
							? this.renderStatus()
							: this.page === "settings"
								? this.renderSettings()
								: html`<div class="stub"><span class="stub-icon">04</span><h2>Statistics</h2><p>This section is reserved for gateway usage and trends.</p></div>`
				}
			</main>
		</div>`;
	}

	static override styles = css`
		:host{--bg:#141414;--surface:#1d1d1d;--raised:#242424;--line:#333;--text:#f1f1ef;--muted:#999;--green:#54c87a;display:block;min-height:100vh;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
		*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--green);outline-offset:3px}
		.shell{display:grid;grid-template-columns:238px minmax(0,1fr);min-height:100vh}.sidebar{display:flex;flex-direction:column;border-right:1px solid var(--line);padding:30px 15px 18px;background:#181818}
		.brand{display:flex;align-items:center;gap:11px;padding:0 11px 44px;font-size:17px;font-weight:650;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:28px;height:28px;border:1px solid #777;border-radius:8px;font-size:19px;font-weight:700}
		.nav-caption,.eyebrow,.map-column h3{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.17em}.nav-caption{padding:0 12px 11px}nav{display:grid;gap:3px}.nav-item{display:flex;align-items:center;gap:14px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:#aaa;text-align:left}.nav-item:hover{background:#242424;color:#eee}.nav-item.active{background:#303030;color:#fff}.nav-code{color:#777;font-size:11px;font-variant-numeric:tabular-nums}.active .nav-code{color:var(--green)}
		.side-foot{display:flex;align-items:center;gap:9px;margin-top:auto;padding:16px 11px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:#777}.dot.good{background:var(--green)}
		main{width:min(100%,1320px);padding:43px clamp(24px,5vw,76px) 100px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:53px}.eyebrow{color:var(--green)}h1{margin:10px 0 4px;font-size:32px;font-weight:580;letter-spacing:-.04em}.top p{margin:0;color:var(--muted)}.refresh,.input-row button{padding:8px 14px;border:1px solid #4a4a4a;border-radius:8px;background:#242424;color:#eee}.refresh:hover,.input-row button:hover{background:#333}.refresh:disabled{opacity:.55;cursor:default}
		.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 17px}.section-title h2{margin:0;font-size:17px;font-weight:590;letter-spacing:-.02em}.section-title span{color:var(--muted);font-size:12px}.lower{margin-top:45px}.notice{margin:0 0 20px;padding:12px 14px;border:1px solid #66512b;border-radius:9px;background:#292216;color:#e6c589}.muted{color:var(--muted)}
		.map{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.map-column{min-width:0}.map-column h3{margin:0 0 13px}.node,.empty-node{min-height:100px;margin-bottom:11px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.node.local{min-height:162px;border-color:#45614a;background:#1d241e}.node-title{display:flex;align-items:center;gap:9px}.node-title strong{font-size:15px;font-weight:570}.node p{margin:7px 0 0;color:var(--muted);font-size:12px}.node-rule{height:1px;margin:23px 0 12px;background:#405043}.empty-node{display:flex;align-items:center;color:#777;font-size:12px}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.model-list,.route-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.model-row,.route-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.model-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.route-link{display:flex;align-items:center;gap:7px;min-width:0}.route-link strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.route-arrow{flex:none;color:var(--green)}.route-counts{margin-left:auto;flex:none;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
		.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.stat{display:grid;gap:10px;min-height:104px;padding:17px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.stat span{color:var(--muted);font-size:12px}.stat strong{font-size:22px;font-weight:560}
		.settings-card{max-width:650px;padding:24px;border:1px solid var(--line);border-radius:11px;background:var(--surface)}.settings-card h3{margin:0 0 4px;font-size:16px}.settings-card p{margin:0 0 25px;color:var(--muted)}.settings-card code{font-size:12px;color:#ccc}.settings-card label{display:block;margin-bottom:7px;font-size:12px}.input-row{display:flex;gap:8px;margin-bottom:25px}.input-row input{min-width:0;flex:1;padding:10px 12px;border:1px solid #474747;border-radius:8px;background:#151515;color:#fff}.setting-line{display:flex;justify-content:space-between;gap:15px;padding:12px 0;border-top:1px solid var(--line);color:var(--muted)}.setting-line code{overflow-wrap:anywhere;text-align:right}
		.stub{display:grid;justify-items:start;max-width:520px;margin:60px auto;color:var(--muted)}.stub-icon{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--line);border-radius:10px;color:var(--green)}.stub h2{margin:18px 0 3px;color:var(--text)}.stub p{margin:0}
		@media(max-width:800px){.shell{grid-template-columns:1fr}.sidebar{padding:14px;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0 6px 12px}.nav-caption,.side-foot{display:none}nav{display:flex;overflow:auto}.nav-item{width:auto;white-space:nowrap}main{padding:28px 20px 60px}.top{padding-bottom:34px}.map{grid-template-columns:1fr}.model-list,.route-list,.status-grid{grid-template-columns:1fr}}
	`;
}

customElements.define("buckle-console", BuckleConsole);
