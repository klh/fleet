// hooks/board-html/usage-monitor.ts — W995: the usage page's drilldown
// monitor, one Lit component. Fetches /api/usage/monitor (the buckle ledger
// grouped by model | provider | hub | lane with throughput, cache, failure
// and latency aggregates + hourly series) and renders: dimension chips, a
// metric selector, one uPlot chart of the top groups over the SHARED window
// (the page's ?days param — the same range the overview charts and the
// cache drilldown ride), and the per-group drilldown table. Light DOM by
// exception (uPlot paints its own canvas; the document-level chrome CSS must
// reach it — the klh-usage-charts pattern), so the monitor-specific chrome
// rides a component-emitted <style> scoped under .kmon. Every metric row
// prints its coverage; unknown stays unknown, never zero.
import { LitElement, html, nothing, type TemplateResult } from "lit";
import type {
	MonitorDim,
	MonitorMetric,
	MonitorReport,
} from "../lib/monitor-drill.ts";

const DIMS: { key: MonitorDim; label: string }[] = [
	{ key: "lane", label: "lane" },
	{ key: "model", label: "model" },
	{ key: "provider", label: "provider" },
	{ key: "hub", label: "hub" },
];

const METRICS: { key: MonitorMetric; label: string; title: string }[] = [
	{
		key: "requests",
		label: "requests/h",
		title: "inference requests per hour",
	},
	{
		key: "throughput",
		label: "throughput",
		title: "provider-reported output tokens per hour",
	},
	{
		key: "failures",
		label: "failures",
		title: "requests answered not-ok or status >= 400 per hour",
	},
	{
		key: "cache",
		label: "cache hits",
		title: "requests with a warm cache read per hour",
	},
	{
		key: "latency",
		label: "latency",
		title: "average provider duration (ms) per hour",
	},
];

// fixed categorical ramp, series index = top-N rank (never cycled per
// render — a group keeps its color between refetches); slots 1-5 are the
// page's model-group palette, 6-8 extend it dark-surface-validated
const RAMP = [
	"#3987e5",
	"#d95926",
	"#199e70",
	"#c98500",
	"#d55181",
	"#7e6bd1",
	"#3f9f9f",
	"#a08a4f",
];

interface UPlotChart {
	width: number;
	setSize(size: { width: number; height: number }): void;
	destroy(): void;
}
interface UPlotCtor {
	new (
		opts: Record<string, unknown>,
		data: unknown[][],
		target: HTMLElement,
	): UPlotChart;
}

const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const pct = (x: number | null): string =>
	x === null ? "—" : `${(x * 100).toFixed(0)}%`;
const ms = (v: number | null): string => (v === null ? "—" : `${String(v)}ms`);
const WORK_CSS = `
.kmon-chips { display:flex; gap:4px; flex-wrap:wrap; margin:8px 0 12px; }
.kmon-chips button { font:inherit; font-size:11px; color:var(--klh-dim); background:none; border:1px solid var(--klh-edge); border-radius:2px; padding:3px 10px; cursor:pointer; }
.kmon-chips button.on, .kmon-chips button:hover { color:var(--klh-accent); border-color:var(--klh-accent); }
.kmon-scroll { overflow-x:auto; }
.kmon table { border-collapse:collapse; width:100%; font-size:11px; }
.kmon th, .kmon td { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid var(--klh-edge-soft); white-space:nowrap; font-variant-numeric:tabular-nums; }
.kmon th { color:var(--klh-dim); font-weight:600; text-transform:uppercase; letter-spacing:.06em; font-size:10px; }
.kmon td.k { color:var(--klh-ink); font-family:var(--klh-font-mono); }
.kmon .dim2 { color:var(--klh-dim); }
`;

export class KlhUsageMonitor extends LitElement {
	static properties = {
		dim: { type: String, state: true },
		metric: { type: String, state: true },
		report: { type: Object, state: true },
		err: { type: String, state: true },
		loading: { type: Boolean, state: true },
	};

	declare dim: MonitorDim;
	declare metric: MonitorMetric;
	declare report: MonitorReport | null;
	declare err: string;
	declare loading: boolean;
	private days = 7;
	private chart: UPlotChart | null = null;
	private ro: ResizeObserver | null = null;
	private onTheme: (() => void) | null = null;
	private gen = 0;

	constructor() {
		super();
		this.dim = "lane";
		this.metric = "requests";
		this.report = null;
		this.err = "";
		this.loading = true;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.days = Math.min(
			90,
			Math.max(
				1,
				Number(new URLSearchParams(location.search).get("days") ?? 7) || 7,
			),
		);
		// deep-link state rides the hash: #monitor/lane/throughput
		const parts = location.hash.replace(/^#monitor\/?/, "").split("/");
		const dim = DIMS.find((d) => d.key === parts[0]);
		if (dim !== undefined) this.dim = dim.key;
		const met = METRICS.find((m) => m.key === parts[1]);
		if (met !== undefined) this.metric = met.key;
		this.onTheme = () => this.mountChart(true);
		document.addEventListener("klh-themechange", this.onTheme);
		void this.load();
	}

	protected disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.onTheme !== null)
			document.removeEventListener("klh-themechange", this.onTheme);
		this.onTheme = null;
		this.ro?.disconnect();
		this.ro = null;
		this.chart?.destroy();
		this.chart = null;
	}

	private async load(): Promise<void> {
		const gen = ++this.gen;
		this.loading = true;
		this.err = "";
		try {
			const res = await fetch(
				`/api/usage/monitor?days=${String(this.days)}&dim=${this.dim}`,
			);
			const body = (await res.json()) as MonitorReport & {
				ok?: boolean;
				error?: string;
			};
			if (gen !== this.gen) return; // a newer fetch superseded this one
			if (!res.ok || body.ok !== true)
				throw new Error(body.error ?? `status ${String(res.status)}`);
			this.report = body;
			this.loading = false;
			await this.updateComplete;
			this.mountChart(false);
		} catch (e) {
			if (gen !== this.gen) return;
			this.err = String(e);
			this.loading = false;
		}
	}

	private setDim(dim: MonitorDim): void {
		this.dim = dim;
		history.replaceState(null, "", `#monitor/${dim}/${this.metric}`);
		void this.load();
	}

	private setMetric(metric: MonitorMetric): void {
		this.metric = metric;
		history.replaceState(null, "", `#monitor/${this.dim}/${metric}`);
		this.mountChart(false);
	}

	// uPlot paints into the light-DOM mount div — see the block comment
	protected createRenderRoot(): HTMLElement {
		return this;
	}

	private mountChart(redrawOnly: boolean): void {
		const uPlot = (globalThis as { uPlot?: UPlotCtor }).uPlot;
		const el = this.querySelector<HTMLElement>("#kmon-chart");
		const series = this.report?.series;
		if (!uPlot || !el || !series) return;
		const metric = this.metric;
		const data = series[metric];
		if (data === undefined) return;
		if (redrawOnly && this.chart !== null) {
			this.chart.destroy();
			this.chart = null;
		}
		if (this.chart !== null) {
			const w = el.clientWidth;
			if (w > 0 && w !== this.chart.width)
				this.chart.setSize({ width: w, height: 240 });
			return;
		}
		const n = series.labels.length;
		const chartSeries: Record<string, unknown>[] = [{}];
		for (let i = 0; i < n; i++) {
			const c = RAMP[i % RAMP.length];
			chartSeries.push({
				label: series.labels[i],
				stroke: c,
				fill: metric === "requests" || metric === "throughput" ? c : undefined,
				width: 1.4,
				points: { show: n <= 2 },
				value: (_u: unknown, v: number | null): string =>
					v === null || !Number.isFinite(v)
						? "—"
						: metric === "throughput"
							? fmtTok(v)
							: metric === "latency"
								? `${String(Math.round(v))}ms`
								: String(Math.round(v)),
			});
		}
		const tok = (name: string, dflt: string): string =>
			getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim() || dflt;
		const axis = (): string => tok("--klh-chart-axis", "#898781");
		const grid = (): string => tok("--klh-chart-grid", "#2c2c2a");
		const hair = (): string => tok("--klh-chart-hair", "#383835");
		this.chart = new uPlot(
			{
				width: el.clientWidth,
				height: 240,
				legend: { show: true, live: true },
				scales: { x: { time: true } },
				series: chartSeries,
				axes: [
					{
						side: 2,
						stroke: axis,
						grid: { show: true, stroke: grid, width: 1 },
						ticks: { show: true, stroke: hair, width: 1 },
					},
					{
						side: 3,
						size: 72,
						stroke: axis,
						grid: { show: false },
						ticks: { show: true, stroke: hair, width: 1 },
					},
				],
			},
			data,
			el,
		);
		if (typeof ResizeObserver === "function") {
			this.ro?.disconnect();
			this.ro = new ResizeObserver(() => {
				const w = el.clientWidth;
				if (this.chart !== null && w > 0 && w !== this.chart.width)
					this.chart.setSize({ width: w, height: 240 });
			});
			this.ro.observe(el);
		}
	}

	protected render(): TemplateResult {
		const r = this.report;
		const cov = r?.coverage;
		const degraded = (r?.hubs ?? []).filter((h) => !h.ok);
		return html`<style>
				${WORK_CSS}
			</style><div class="upanel kmon">
			<div class="uhead">
				<h2>MONITOR · DRILLDOWN BY ${this.dim.toUpperCase()}</h2>
				<p class="ufoot">${String(this.days)}d shared window · buckle request ledger · hover = values · drag = zoom · double-click = reset</p>
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor dimension">
				${DIMS.map(
					(d) => html`<button
						class=${d.key === this.dim ? "on" : ""}
						@click=${() => this.setDim(d.key)}
					>${d.label}</button>`,
				)}
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor metric">
				${METRICS.map(
					(m) => html`<button
						class=${m.key === this.metric ? "on" : ""}
						title=${m.title}
						@click=${() => this.setMetric(m.key)}
					>${m.label}</button>`,
				)}
			</div>
			<div class="ulegend">
				${(r?.series?.labels ?? []).map(
					(label, i) =>
						html`<span><i style=${`background:${RAMP[i % RAMP.length]}`}></i
							>${label}</span>`,
				)}
			</div>
			<div id="kmon-chart" class="uchart"></div>
			${this.loading ? html`<p class="uempty">Loading monitor…</p>` : nothing}
			${this.err !== "" ? html`<p class="uempty" role="alert">Monitor unavailable: ${this.err}</p>` : nothing}
			${
				cov !== undefined
					? html`<p class="ufoot">
						${String(cov.requests)} inference requests
						(${String(cov.probe_requests)} probes excluded) · tokens reported
						${String(cov.rows_with_tokens)} · duration ${String(cov.rows_with_duration)} · cache
						verdicts ${String(cov.rows_with_cache_verdict)} · failure verdicts
						${String(cov.rows_with_failure_verdict)} · hub ceiling
						${String(cov.per_hub_row_limit)} rows/hub${
							r?.transcripts
								? ` · transcript meter ${r.transcripts.source} (${String(r.transcripts.requests)} req, ${fmtTok(r.transcripts.cache_read_tokens)} cache-read tok)`
								: ""
						}
					</p>`
					: nothing
			}
			${
				degraded.length > 0
					? html`<p class="uempty">hubs degraded: ${degraded.map((h) => `${h.label} (${h.reason ?? "unreachable"})`).join(" · ")}</p>`
					: nothing
			}
		</div>
		<div class="upanel kmon">
			<h2>GROUPS · ${this.dim.toUpperCase()}</h2>
			${
				r === null || r.rows.length === 0
					? html`<p class="uempty">${this.loading ? "" : "No request-ledger rows in this window."}</p>`
					: html`<div class="kmon-scroll"><table>
						<thead><tr>
							<th>${this.dim}</th><th>req</th><th>out tok</th><th>fail</th>
							<th>cache warm</th><th>p50</th><th>p95</th>
							${this.dim === "lane" ? html`<th title="W243 meter: orientation share · context share · searches/request">work type</th>` : nothing}
						</tr></thead>
						<tbody>${r.rows.map(
							(row) => html`<tr>
								<td class="k">${row.key}</td>
								<td>${String(row.requests)}</td>
								<td>${row.tok_reported > 0 ? fmtTok(row.out_tok) : "—"}</td>
								<td>${row.failure_observed > 0 ? pct(row.failures / row.failure_observed) : "—"}</td>
								<td>${row.known > 0 ? pct(row.warm_ratio) : "—"}</td>
								<td>${ms(row.lat_p50_ms)}</td>
								<td>${ms(row.lat_p95_ms)}</td>
								${
									this.dim === "lane"
										? html`<td class="dim2">${row.work === null ? "—" : `orient ${pct(row.work.orient)} · ctx ${pct(row.work.context)} · ${row.work.spr.toFixed(2)} srq`}</td>`
										: nothing
								}
							</tr>`,
						)}</tbody>
					</table></div>`
			}
		</div>`;
	}
}

customElements.define("klh-usage-monitor", KlhUsageMonitor);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-monitor": KlhUsageMonitor;
	}
}
