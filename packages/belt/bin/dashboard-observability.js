import { html, css, LitElement } from "/vendor/lit.js";
import {
	supervisorFresh,
	restartEvidence,
	targetStateLabel,
} from "/dashboard-state.js";
import { observationFresh } from "/observation.js";

// W902: UTC-first dual stamp — a bare local time is unreadable across hubs
const dualStamp = (ms) => {
	if (!ms) return "";
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return String(ms);
	const p = (n) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const a = Math.abs(off);
	const sg = off >= 0 ? "+" : "-";
	const utc = d.toISOString().replace(/\.\d{3}Z$/, "Z");
	const loc = `local ${p(d.getHours())}:${p(d.getMinutes())}, UTC${sg}${p(Math.floor(a / 60))}:${p(a % 60)}`;
	return `${utc} (${loc})`;
};

class BeltSupervisor extends LitElement {
	static properties = {
		snapshot: { state: true },
		error: { state: true },
		busy: { state: true },
		now: { state: true },
	};
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		.heading { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		p { margin:var(--klh-space-2) 0; color:var(--klh-dim); font-size:var(--klh-text-sm); }
		button { margin-left:auto; background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:focus-visible, summary:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		button:disabled { opacity:.6; cursor:wait; }
		details { border-top:1px solid var(--klh-edge-faint); padding-block:var(--klh-space-2); }
		summary { cursor:pointer; overflow-wrap:anywhere; }
		.state { margin-inline:var(--klh-space-3); color:var(--klh-dim); }
		.alert { color:var(--klh-danger); }
		.reason { color:var(--klh-ink); overflow-wrap:anywhere; }
		.group { margin-block-start:var(--klh-space-3); font-size:var(--klh-text-xs); text-transform:uppercase; letter-spacing:.14em; color:var(--klh-dim); }
	`;
	constructor() {
		super();
		this.snapshot = null;
		this.error = "";
		this.busy = false;
		this.now = Date.now();
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => {
			this.now = Date.now();
			this.refresh();
		}, 5000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		this.controller?.abort();
	}
	async refresh() {
		if (this.busy) return;
		this.busy = true;
		this.controller = new AbortController();
		const timeout = setTimeout(() => this.controller.abort(), 5000);
		try {
			const response = await fetch("/api/supervisor", {
				signal: this.controller.signal,
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const snapshot = await response.json();
			if (
				snapshot &&
				(!Array.isArray(snapshot.targets) ||
					!Number.isFinite(snapshot.intervalMs))
			)
				throw new Error("Invalid supervisor snapshot");
			this.snapshot = snapshot;
			this.error = "";
		} catch (error) {
			this.error = `Supervisor feed unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
			this.now = Date.now();
			this.busy = false;
		}
	}
	render() {
		const doc = this.snapshot;
		// W853: a null snapshot with no fetch error means no supervisor has
		// ever run on this host (hub/container posture — belt-swarm lives on
		// the Mac spoke; hub belt only observes). The panel is removed there:
		// it can never show anything, and a standing red "unknown" misreports
		// service state. A real or stale snapshot still renders below.
		if (!doc && !this.error) return html``;
		const fresh =
			!this.error &&
			supervisorFresh(doc, this.now) &&
			observationFresh(doc?.observation, this.now);
		const targets = doc?.targets ?? [];
		const fleetRows = targets.filter((t) => t.kind !== "hub");
		const hubs = targets.filter((t) => t.kind === "hub");
		const alerts = targets.filter(
			(target) => target.alert || target.preflightError,
		).length;
		const idle = targets.filter((target) => target.state === "idle").length;
		const age = doc
			? Math.max(0, Math.round((this.now - Date.parse(doc.updated)) / 1000))
			: null;
		return html`
			<div class="heading"><h2>Supervisor</h2><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy ? "Refreshing…" : "Refresh status"}</button></div>
			<p role="status" class=${fresh ? "" : "alert"}>${this.error || (fresh ? `${alerts} need attention · ${idle} on demand · probes ${age}s ago` : `Supervisor snapshot stale (${age}s old). Current service state is unknown.`)}</p>
			${doc?.observation ? html`<p>Evidence: ${doc.observation.source} · ${doc.observation.scope} · expires ${dualStamp(doc.observation.expiresAt)}</p>` : ""}
			<details><summary>${targets.length} monitored endpoints · view probe details</summary>
				${fleetRows.map((target) => this.row(target, fresh, doc))}
				${
					hubs.length
						? html`<p class="group">hubs — remote buckle fronts, probe-only</p>${hubs.map((target) => this.row(target, fresh, doc))}`
						: ""
				}
			</details>
			`;
	}
	row(target, fresh, doc) {
		const state = fresh ? targetStateLabel(target, doc, this.now) : "unknown";
		return html`<details><summary>${displayLabel(target.name)} :${target.port}<span class="state ${fresh && target.alert ? "alert" : ""}">${state}</span></summary>
				<p>${target.kind} · ${target.owned ? "supervised" : "observed"} · ${restartEvidence(target)}</p>
				<p>Last successful probe: ${target.lastOk || "none recorded"}${target.nextRetryAt ? ` · retry after ${target.nextRetryAt}` : ""}</p>
				${target.preflightError || target.lastError ? html`<p class="reason">${target.preflightError || target.lastError}</p>` : ""}
			</details>`;
	}
}
customElements.define("belt-supervisor", BeltSupervisor);
// ─── <belt-trends> — uPlot trends + sparklines over /api/metrics/history ──
// Light DOM by exception: uPlot paints its own canvas DOM inside the mount
// divs and the document-level vendor CSS must reach it — createRenderRoot
// returns the element itself (the board's <klh-usage-charts> call). Compact
// by default: the <details> summary carries the headline numbers, charts
// draw lazily on first expand, refetch every 30s while connected.
class BeltTrends extends LitElement {
	static properties = {
		hist: { state: true },
		err: { state: true },
		open: { state: true },
	};
	constructor() {
		super();
		this.hist = null;
		this.err = "";
		this.open = true;
		this.drawnFor = null;
		this.charts = [];
		this.ros = [];
		this.busy = false;
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 30000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		this.controller?.abort();
		for (const ro of this.ros) ro.disconnect();
		this.teardown();
	}
	createRenderRoot() {
		return this;
	}
	async refresh() {
		if (this.busy) return;
		this.busy = true;
		this.controller = new AbortController();
		const timeout = setTimeout(() => this.controller.abort(), 5000);
		try {
			const response = await fetch("/api/metrics/history", {
				signal: this.controller.signal,
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const hist = await response.json();
			if (
				!hist ||
				!Array.isArray(hist.buckets) ||
				!Array.isArray(hist.endpoints)
			)
				throw new Error("Invalid history payload");
			this.hist = hist;
			this.err = "";
		} catch (error) {
			this.err = `Trend feed unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
			this.busy = false;
		}
	}
	toggled(event) {
		this.open = event.target.open;
		if (!this.open) this.teardown();
	}
	render() {
		if (!this.hist && !this.err) return html``;
		const buckets = this.hist?.buckets ?? [];
		const endpoints = this.hist?.endpoints ?? [];
		const total = buckets.reduce((a, b) => a + b[1], 0);
		const errs = buckets.reduce((a, b) => a + b[2], 0);
		const hours = this.hist ? Math.round(this.hist.windowMs / 3600000) : 6;
		const active = buckets.filter((b) => b[1] > 0).length;
		const last = buckets.findLast((b) => b[1] > 0);
		return html`
			<style>
				belt-trends { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
				belt-trends summary { cursor:pointer; overflow-wrap:anywhere; color:var(--klh-ink); }
				belt-trends summary:hover { color:var(--klh-ink); }
				belt-trends .bt-err { color:var(--klh-danger); overflow-wrap:anywhere; }
				belt-trends .bt-note { color:var(--klh-dim); font-size:var(--klh-text-xs); margin:6px 0 12px; }
				belt-trends .bt-title { color:var(--klh-ink); font-size:var(--klh-text-sm); margin:18px 0 4px; }
				belt-trends .bt-sparks { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px 24px; margin-top:12px; }
				belt-trends .bt-spark { min-width:0; border-top:1px solid var(--klh-edge-faint); padding-top:7px; }
				belt-trends .bt-spark .lbl { display:flex; justify-content:space-between; gap:8px; font-size:var(--klh-text-xs); color:var(--klh-dim); font-variant-numeric:tabular-nums; }
				belt-trends .bt-spark .lbl span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
				belt-trends .bt-spark .mount { height:34px; overflow:hidden; }
				belt-trends .bt-wrap { max-width:100%; overflow:hidden; }
				belt-trends .bt-trend-wrap { position:relative; }
				belt-trends .bt-hover { position:absolute; z-index:2; top:8px; max-width:220px; padding:6px 9px; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); background:var(--klh-surface); color:var(--klh-ink); box-shadow:0 4px 14px #0003; pointer-events:none; font-size:var(--klh-text-xs); font-variant-numeric:tabular-nums; }
				belt-trends .bt-hover[hidden] { display:none; }
				belt-trends .bt-raster { display:grid; grid-template-columns:repeat(72,minmax(0,1fr)); gap:2px; height:42px; align-items:end; border-bottom:1px solid var(--klh-edge); margin-top:12px; }
				belt-trends .bt-cell { min-width:0; height:4px; background:var(--klh-edge-faint); }
				belt-trends .bt-cell.active { height:34px; background:var(--klh-accent); }
				belt-trends .bt-cell.failed { background:var(--klh-danger); }
				belt-trends .bt-times { display:flex; justify-content:space-between; color:var(--klh-dim); font-size:var(--klh-text-xs); margin-top:4px; }
				belt-trends .bt-list { width:100%; border-collapse:collapse; margin-top:16px; font-size:var(--klh-text-sm); }
				belt-trends .bt-list th, belt-trends .bt-list td { padding:7px 8px 7px 0; border-bottom:1px solid var(--klh-edge-faint); text-align:left; }
				belt-trends .bt-list th { color:var(--klh-dim); font-size:var(--klh-text-xs); font-weight:400; text-transform:uppercase; letter-spacing:.08em; }
				belt-trends .bt-list td:nth-child(n+3) { font-variant-numeric:tabular-nums; }
			</style>
			<details class="bt" ?open=${this.open} @toggle=${this.toggled}>
				<summary>
					Trends · ${hours}h · ${total} Belt routes · ${errs} failed
					${this.err ? html`<span class="bt-err"> · ${this.err}</span>` : ""}
				</summary>
				${this.open && this.hist ? html`<p class="bt-note">Belt router observations only · ${active} active 5-minute intervals · ${endpoints.length} endpoints${last ? ` · last route ${dualStamp(last[0] * 1000)}` : ""}. Buckle traffic is measured separately in Metrics.</p>${this.body()}` : ""}
			</details>`;
	}
	body() {
		const total = this.hist.buckets.reduce((sum, bucket) => sum + bucket[1], 0);
		if (total > 0 && total < 12) return this.sparseBody();
		const uPlotOk = Boolean(globalThis.uPlot);
		if (!uPlotOk)
			return html`<p class="bt-note">chart engine not loaded — trend charts degraded</p>`;
		if (!this.hist.buckets.length)
			return html`<p class="bt-note">no history yet</p>`;
		return html`<div class="bt-wrap">
			<p class="bt-title">Requests and failures · 5-minute buckets</p>
			<div class="bt-trend-wrap"><div class="bt-trend"></div><div class="bt-hover" hidden></div></div>
			<p class="bt-title">Average response time · milliseconds per active bucket</p>
			<div class="bt-latency"></div>
			<p class="bt-title">Routes by endpoint</p>
			<div class="bt-sparks">
				${this.hist.endpoints.map(
					(ep) => html`<div class="bt-spark" data-key=${ep.key}>
						<span class="lbl"><span>${ep.key}</span><span>${ep.counts.reduce((a, b) => a + b, 0)} req</span></span>
						<div class="mount"></div>
					</div>`,
				)}
			</div>
		</div>`;
	}
	sparseBody() {
		const buckets = this.hist.buckets;
		const first = buckets[0];
		const last = buckets.at(-1);
		// W908 port of W902: axis marks are UTC-first — hub clocks drift
		const time = (bucket) =>
			`${new Date(bucket[0] * 1000).toISOString().slice(11, 16)}Z`;
		const active = buckets
			.map((bucket, index) => ({ bucket, index }))
			.filter(({ bucket }) => bucket[1] > 0)
			.reverse();
		return html`<div class="bt-wrap">
			<p class="bt-title">Activity · each mark is a 5-minute interval</p>
			<div class="bt-raster" role="img" aria-label=${`${active.length} intervals had Belt routes in the last six hours`}>
				${buckets.map((bucket) => html`<span class=${`bt-cell${bucket[1] ? " active" : ""}${bucket[2] ? " failed" : ""}`} title=${`${time(bucket)} · ${bucket[1]} routes · ${bucket[2]} failed`}></span>`)}
			</div>
			<div class="bt-times"><span>${first ? time(first) : ""}</span><span>${last ? time(last) : ""}</span></div>
			<table class="bt-list"><thead><tr><th>Time</th><th>Endpoint</th><th>Routes</th><th>Failed</th><th>Avg response</th></tr></thead>
				<tbody>${active.map(
					({ bucket, index }) =>
						html`<tr><td>${time(bucket)}</td><td>${
							this.hist.endpoints
								.filter((endpoint) => endpoint.counts[index] > 0)
								.map((endpoint) => endpoint.key)
								.join(", ") || "unknown"
						}</td><td>${bucket[1]}</td><td>${bucket[2]}</td><td>${bucket[3] == null ? "—" : `${bucket[3]} ms`}</td></tr>`,
				)}</tbody>
			</table>
		</div>`;
	}
	updated(changed) {
		super.updated(changed);
		if (!this.open || !this.hist || this.drawnFor === this.hist) return;
		if (this.hist.buckets.reduce((sum, bucket) => sum + bucket[1], 0) < 12)
			return;
		const uPlot = globalThis.uPlot;
		if (!uPlot) return;
		this.teardown();
		this.draw(uPlot);
		this.drawnFor = this.hist;
	}
	draw(uPlot) {
		const tok = (name, dflt) => {
			const v = getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim();
			return v || dflt;
		};
		const grid = () => tok("--klh-chart-grid", "#2c2c2a");
		const hair = () => tok("--klh-chart-hair", "#383835");
		const axis = () => tok("--klh-chart-axis", "#898781");
		const accent = () => tok("--klh-accent", "#8f8f74");
		const danger = () => tok("--klh-danger", "#c0392b");
		const int = (_u, v) => (v == null ? "—" : String(Math.round(v)));
		const mkAxis = (side) => ({
			side,
			stroke: axis,
			grid: { show: true, stroke: grid, width: 1 },
			ticks: { show: true, stroke: hair, width: 1 },
		});
		const buckets = this.hist.buckets;
		const times = buckets.map((b) => b[0]);
		const base = (h) => ({
			width: 640,
			height: h,
			scales: { x: { time: true } },
			axes: [mkAxis(2), mkAxis(3)],
		});
		const trendEl = this.querySelector(".bt-trend");
		if (trendEl) {
			const hover = this.querySelector(".bt-hover");
			this.chart(
				trendEl,
				uPlot,
				{
					...base(185),
					legend: { show: true, live: true },
					hooks: {
						setCursor: [
							(plot) => {
								if (!hover) return;
								const index = plot.cursor.idx;
								if (index == null || !buckets[index]) {
									hover.hidden = true;
									return;
								}
								const bucket = buckets[index];
								hover.textContent = `${dualStamp(bucket[0] * 1000)} · ${bucket[1]} requests · ${bucket[2]} failed`;
								hover.hidden = false;
								hover.style.left = `${Math.max(8, Math.min(plot.cursor.left + 12, trendEl.clientWidth - hover.offsetWidth - 8))}px`;
							},
						],
					},
					series: [
						{},
						{
							label: "req / 5 min",
							stroke: accent,
							fill: () => `${accent()}2e`,
							width: 1.5,
							points: {
								show: buckets.reduce((sum, b) => sum + b[1], 0) < 16,
								size: 5,
							},
							value: int,
						},
						{
							label: "errors",
							stroke: danger,
							width: 1.5,
							points: { show: false },
							value: int,
						},
					],
				},
				[times, buckets.map((b) => b[1]), buckets.map((b) => b[2])],
			);
		}
		const latEl = this.querySelector(".bt-latency");
		if (latEl) {
			const dim = () => tok("--klh-chart-axis", "#898781");
			this.chart(
				latEl,
				uPlot,
				{
					...base(125),
					legend: { show: true, live: true },
					series: [
						{},
						{
							label: "avg ms",
							stroke: dim,
							fill: () => `${dim()}1e`,
							width: 1.5,
							points: { show: true, size: 5 },
							value: (_u, v) => (v == null ? "—" : `${Math.round(v)}ms`),
						},
					],
				},
				[times, buckets.map((b) => b[3])],
			);
		}
		const spark = (mount, counts) => {
			this.chart(
				mount,
				uPlot,
				{
					height: 28,
					legend: { show: false },
					axes: [{ show: false }, { show: false }],
					padding: [2, 0, 2, 0],
					scales: { x: { time: true } },
					series: [
						{},
						{
							stroke: accent,
							fill: () => `${accent()}1a`,
							width: 1,
							points: { show: false },
						},
					],
				},
				[times, counts],
			);
		};
		for (const row of this.querySelectorAll(".bt-spark")) {
			const ep = this.hist.endpoints.find((e) => e.key === row.dataset.key);
			if (ep) spark(row.querySelector(".mount"), ep.counts);
		}
	}
	chart(el, uPlot, opts, data) {
		if (!el) return;
		opts.width = el.clientWidth || opts.width || 640;
		const u = new uPlot(opts, data, el);
		this.charts.push(u);
		if (typeof ResizeObserver !== "function") return;
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth;
			if (w > 0 && w !== u.width) u.setSize({ width: w, height: opts.height });
		});
		ro.observe(el);
		this.ros.push(ro);
	}
	teardown() {
		for (const u of this.charts) u.destroy?.();
		this.charts = [];
		for (const ro of this.ros) ro.disconnect();
		this.ros = [];
		this.drawnFor = null;
	}
}
customElements.define("belt-trends", BeltTrends);
