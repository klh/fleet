// hooks/board-html/usage-cache-drill.ts — W825: the usage page's cache
// drilldown as one Lit component (W184 pattern: plain Lit, shadow DOM, lit-html
// templates only). Serves the owner's optimization loop: per-lane warm-cache
// ratio (share of requests that HIT cache — the clone-reuse metric), the
// miss-reason clusters (not just counts — REASONS), and the usage → lane →
// request drilldown. Data rides GET /api/usage/cache-drill (routes-usage.ts →
// lib/cache-drill.ts); the component fetches per filter change, so the server
// page only emits the static host. Filters are client state (the drilldown is
// a live view, unlike the server-shaped URL filters above it).
import {
	LitElement,
	css,
	html,
	nothing,
	type CSSResultGroup,
	type TemplateResult,
} from "lit";
import type {
	BuckleRequestRow,
	CacheDrillReport,
	HubDrillStatus,
	LaneDrillRow,
	MissReasonCluster,
	ModelDrillRow,
} from "../lib/cache-drill.ts";

// ─── formatting (same ramp as usage-panels) ───────────────────────────────
const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;
const hhmm = (ts: string | null): string =>
	ts === null || ts.length < 16 ? "—" : ts.slice(11, 16);

export class KlhUsageCacheDrill extends LitElement {
	static properties = {
		report: { type: Object, state: true },
		err: { type: String, state: true },
		loading: { type: Boolean, state: true },
		lane: { type: String, state: true },
		days: { type: Number, state: true },
		model: { type: String, state: true },
		day: { type: String, state: true },
		missOnly: { type: Boolean, state: true },
	};

	declare report: CacheDrillReport | null;
	declare err: string;
	declare loading: boolean;
	declare lane: string;
	declare days: number;
	declare model: string;
	declare day: string;
	declare missOnly: boolean;

	constructor() {
		super();
		this.report = null;
		this.err = "";
		this.loading = true;
		this.lane = "";
		this.days = 7;
		this.model = "";
		this.day = "";
		this.missOnly = false;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.refresh();
	}

	private refresh(): void {
		const p = new URLSearchParams();
		p.set("days", String(this.days));
		if (this.lane) p.set("lane", this.lane);
		if (this.model) p.set("model", this.model);
		if (this.day) p.set("day", this.day);
		if (this.missOnly) p.set("miss_only", "1");
		this.loading = true;
		this.err = "";
		fetch(`/api/usage/cache-drill?${p.toString()}`, {
			signal: AbortSignal.timeout(15_000),
		})
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
				return r.json() as Promise<CacheDrillReport>;
			})
			.then((body) => {
				this.report = body;
				this.loading = false;
			})
			.catch((e) => {
				this.err = String((e as Error).message ?? e);
				this.loading = false;
			});
	}

	// ─── render ────────────────────────────────────────────────────────────
	protected render(): TemplateResult {
		if (this.err)
			return html`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;
		const r = this.report;
		if (r === null)
			return html`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;
		return html`${this.lanePanel(r)} ${this.scopePanel(r)}`;
	}

	private lanePanel(r: CacheDrillReport): TemplateResult {
		const degraded = r.hubs.filter((h) => !h.ok);
		const unfiltered = r.hubs.filter((h) => (h.excluded ?? 0) > 0);
		return html`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(r.days)}d window
					${
						degraded.length > 0
							? html`· <span class="uwarn"
								>${String(degraded.length)}/${String(r.hubs.length)} sources
								degraded: ${degraded.map((h) => h.label).join(", ")}</span
							>`
							: nothing
					}
				</p>
			</div>
			${this.filterRow(r)}
			${
				r.overall.requests > r.overall.known
					? html`<p class="uwarn">Cache verdicts are available for
					${String(r.overall.known)} of ${String(r.overall.requests)}
					requests. Warm rates exclude the rest.</p>`
					: nothing
			}
			${
				r.local_transcripts && r.local_transcripts.cache_read_tokens > 0
					? html`<p class="ufoot">Local Claude transcripts report
					${fmtTok(r.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${fmtTok(r.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${
						r.local_transcripts.source === "legacy-aggregate"
							? " and uses the legacy rollup"
							: ""
					}.</p>`
					: nothing
			}
			${
				degraded.length > 0
					? html`<p class="uwarn">Missing request data: ${degraded
							.map((h) => `${h.label} (${h.reason ?? "unavailable"})`)
							.join(", ")}. Rates cover responding sources only.</p>`
					: nothing
			}
			${
				r.hubs.some((h) => h.ok && (h.rawRows ?? h.rows) >= 500)
					? html`<p class="uwarn">A source reached the 500-request read limit. Rates cover its newest requests only.</p>`
					: nothing
			}
			${
				unfiltered.length > 0
					? html`<p class="uwarn">Excluded non-model audit rows from ${unfiltered.map((h) => h.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`
					: nothing
			}
			${this.reasonsTable(r.overall.reasons, "ALL LANES", r.overall.known)}
			${this.modelTable(r.models)}
			${this.laneTable(r.lanes, degraded.length > 0)}
		</div>`;
	}

	private modelTable(models: ModelDrillRow[]): TemplateResult {
		if (models.length === 0) return nothing;
		return html`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${models.map(
					(m) => html`<tr>
						<td>${m.model}</td><td class="unum">${fmtTok(m.requests)}</td>
						<td class="unum">${fmtTok(m.known)}</td>
						<td>${m.known > 0 ? pct1(m.warm_ratio) : "—"}</td>
						<td class="unum">${fmtTok(m.cache_r_tok)}</td><td>${m.status}</td>
					</tr>`,
				)}</tbody>
			</table>`;
	}

	private filterRow(r: CacheDrillReport): TemplateResult {
		const models = [...new Set(r.lanes.flatMap((l) => l.models))].sort();
		const dayOpts = [
			...new Set(r.lanes.flatMap((l) => l.day_series.map((c) => c.d))),
		]
			.sort()
			.reverse();
		return html`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(e: Event) => {
						this.days = Number((e.target as HTMLSelectElement).value);
						this.lane = "";
						this.refresh();
					}}
				>
					${[7, 14, 28, 90].map(
						(d) =>
							html`<option value=${String(d)} ?selected=${d === this.days}
								>${String(d)}</option
							>`,
					)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(e: Event) => {
						this.model = (e.target as HTMLSelectElement).value;
						this.refresh();
					}}
				>
					${["", ...models].map(
						(m) =>
							html`<option value=${m} ?selected=${m === this.model}
								>${m === "" ? "any" : m}</option
							>`,
					)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(e: Event) => {
						this.day = (e.target as HTMLSelectElement).value;
						this.refresh();
					}}
				>
					${["", ...dayOpts].map(
						(d) =>
							html`<option value=${d} ?selected=${d === this.day}
								>${d === "" ? "all" : d}</option
							>`,
					)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(e: Event) => {
						this.missOnly = (e.target as HTMLInputElement).checked;
						this.refresh();
					}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(r.overall.requests)} req ·
				${String(r.overall.known)} known · warm
						<b>${r.overall.known > 0 ? pct1(r.overall.warm_ratio) : "—"}</b>
				${this.loading ? html`<span class="uempty">· refreshing…</span>` : nothing}
			</span>
		</div>`;
	}

	private reasonsTable(
		reasons: MissReasonCluster[],
		scope: string,
		known: number,
	): TemplateResult {
		return html`<h3>MISS REASONS · ${scope}</h3>
			${
				reasons.length === 0
					? html`<p class="uempty">${
							known > 0
								? "no cache misses among the requests with reported usage"
								: "no cache verdicts in scope"
						}</p>`
					: html`<table class="uacts">
							<thead>
								<tr>
									<th>reason</th>
									<th class="unum">misses</th>
									<th>example rid</th>
									<th>what to do</th>
								</tr>
							</thead>
							<tbody>
								${reasons.map(
									(c) => html`<tr>
										<td><b>${c.label}</b></td>
										<td class="unum">${String(c.count)}</td>
										<td class="urid" title=${c.example_rid}>
											${c.example_rid}
										</td>
										<td class="uwhy">${c.detail}</td>
									</tr>`,
								)}
							</tbody>
						</table>`
			}`;
	}

	private laneTable(lanes: LaneDrillRow[], degraded: boolean): TemplateResult {
		if (lanes.length === 0)
			return html`<p class="uempty">
				${
					degraded
						? "lane data unavailable from the failed sources"
						: "no requests recorded for this scope"
				}
			</p>`;
		const maxReq = Math.max(1, ...lanes.map((l) => l.requests));
		return html`<table class="uacts">
			<thead>
				<tr>
					<th>lane</th>
					<th class="unum">req</th>
					<th>warm ratio</th>
					<th class="unum">cache read</th>
					<th class="unum">cache write</th>
					<th>last</th>
				</tr>
			</thead>
			<tbody>
				${lanes.map((l) => {
					const w = l.known > 0 ? (l.warm / l.known) * 100 : 0;
					return html`<tr
						class="ulane"
						@click=${() => {
							this.lane = l.lane === "(bare ingress)" ? "" : l.lane;
							this.refresh();
						}}
					>
						<td>
							<b>${l.lane}</b>
							${l.hubs.map((h) => html`<span class="uchip">${h}</span>`)}
							${
								l.models.length > 1
									? html`<span class="uwarn">${String(l.models.length)} models</span>`
									: nothing
							}
						</td>
						<td class="unum">
							${fmtTok(l.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4, (l.requests / maxReq) * 100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${w >= 50 ? "uwarm" : "ucold"}
									style=${`width:${String(Math.max(2, w))}%`}
									title=${`${pct1(w / 100)} of ${String(l.known)} known`}
								></i
							></span>
							<span class="unum">${l.known > 0 ? pct1(w / 100) : "—"}</span>
						</td>
						<td class="unum">${fmtTok(l.cache_r_tok)}</td>
						<td class="unum" title=${l.cache_c_known ? `${String(l.cache_c_known)} requests reported cache writes` : "Provider did not report cache writes"}>${l.cache_c_known ? fmtTok(l.cache_c_tok) : "—"}</td>
						<td class="unum">${hhmm(l.last_ts)}</td>
					</tr>`;
				})}
			</tbody>
		</table>`;
	}

	private scopePanel(r: CacheDrillReport): TemplateResult {
		const scope = r.lane_scope;
		if (scope === null) return nothing;
		const rows: BuckleRequestRow[] = scope.requests;
		const status: HubDrillStatus[] = r.hubs;
		return html`<div class="upanel">
			<div class="uhead">
				<h2>LANE ${scope.lane} · REQUESTS</h2>
				<button
					class="ubtn"
					@click=${() => {
						this.lane = "";
						this.refresh();
					}}
				>
					← all lanes
				</button>
			</div>
			${this.reasonsTable(
				scope.reasons,
				scope.lane,
				rows.filter(
					(row) => row.cache_reported === true || (row.cache_r ?? 0) > 0,
				).length,
			)}
			<table class="uacts">
				<thead>
					<tr>
						<th>ts</th>
						<th>model</th>
						<th class="unum">status</th>
						<th class="unum">cache r</th>
						<th class="unum">cache w</th>
						<th class="unum">ms</th>
						<th>hub</th>
					</tr>
				</thead>
				<tbody>
					${
						rows.length === 0
							? html`<tr>
								<td colspan="7" class="uempty">no requests in scope</td>
							</tr>`
							: rows.map((row) => {
									const hub =
										status.find((h) => h.label === row.hub)?.label ??
										row.hub ??
										"";
									return html`<tr class=${row.ok === false ? "ubad" : ""}>
									<td class="unum">${row.ts.slice(11, 19)}</td>
									<td>${row.target_model ?? "—"}</td>
									<td class="unum">${row.status === null ? "—" : String(row.status)}</td>
									<td class="unum ${row.cache_r === 0 ? "ucoldtext" : ""}">
										${row.cache_r === null ? "—" : fmtTok(row.cache_r)}
									</td>
									<td class="unum">
										${row.cache_c_reported ? fmtTok(row.cache_c ?? 0) : "—"}
									</td>
									<td class="unum">
										${row.duration_ms === null ? "—" : fmtTok(row.duration_ms)}
									</td>
									<td><span class="uchip">${hub}</span></td>
								</tr>`;
								})
					}
				</tbody>
			</table>
		</div>`;
	}
}

KlhUsageCacheDrill.styles = [
	css`
		:host {
			display: block;
		}
		.upanel {
			display: block;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
			border-radius: 3px;
			padding: 12px 14px 10px;
			margin-bottom: 14px;
		}
		.upanel h2 {
			margin: 0 0 6px;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
		}
		.uhead {
			display: flex;
			align-items: baseline;
			gap: 12px;
		}
		.uhead .ufoot {
			margin: 0;
		}
		.ufoot {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			margin: 2px 0 8px;
		}
		h3 {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			margin: 12px 0 4px;
		}
		table.uacts {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		table.uacts td,
		table.uacts th {
			padding: 6px 8px;
			border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
			text-align: left;
		}
		.unum {
			text-align: right;
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink-2, #c9c6bf);
			white-space: nowrap;
		}
		.uchip {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			padding: 1px 6px;
			margin-left: 6px;
		}
		.uempty {
			color: var(--klh-dim, #98958e);
			font-size: 12px;
		}
		.uwarn {
			color: var(--klh-danger, #e5484d);
			font-size: 10.5px;
		}
		.ucoldtext {
			color: var(--klh-danger, #e5484d);
		}
		tr.ubad td {
			color: var(--klh-dim, #98958e);
		}
		.ufrow {
			display: flex;
			gap: 14px;
			align-items: center;
			flex-wrap: wrap;
			margin: 6px 0 10px;
			font-size: 11px;
		}
		.ufrow label {
			display: flex;
			gap: 6px;
			align-items: center;
			color: var(--klh-dim, #98958e);
		}
		.ufrow select {
			background: var(--klh-surface, #1c1b19);
			color: var(--klh-ink, #e8e6e1);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 4px;
		}
		.uoverall {
			margin-left: auto;
			color: var(--klh-dim, #98958e);
			font-variant-numeric: tabular-nums;
		}
		.uoverall b {
			color: var(--klh-ink, #e8e6e1);
		}
		.ubarslot {
			display: inline-block;
			vertical-align: middle;
			width: 60px;
			margin-left: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.ubarslot i.ureq {
			display: block;
			height: 4px;
			background: var(--klh-accent-dim, rgba(216, 144, 15, 0.45));
		}
		.uwr {
			display: inline-block;
			vertical-align: middle;
			width: 80px;
			margin-right: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.uwr i {
			display: block;
			height: 8px;
		}
		.uwr i.uwarm {
			background: var(--klh-ok-ink, #3dd68c);
		}
		.uwr i.ucold {
			background: var(--klh-danger, #e5484d);
		}
		tr.ulane {
			cursor: pointer;
		}
		tr.ulane:hover td {
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.04));
		}
		.urid {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			max-width: 16ch;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.uwhy {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			max-width: 46ch;
		}
		.ubtn {
			background: transparent;
			color: var(--klh-accent, #d8900f);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 8px;
			cursor: pointer;
		}
	` as CSSResultGroup,
];

customElements.define("klh-usage-cache-drill", KlhUsageCacheDrill);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-cache-drill": KlhUsageCacheDrill;
	}
}
