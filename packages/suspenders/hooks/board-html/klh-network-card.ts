// hooks/board-html/klh-network-card.ts — W858.10.3: the admin Network
// overview card on /console/belt (the gateway console). Renders buckle's
// measured network telemetry: per-hub rows (TTL-bounded active + observer
// freshness), per-interface trailing-window edges (60s rate / 15m workload,
// nulls stay null), recent successful routes, hour buckets, and the local
// spoke probe row. SSR seed via the esc(JSON) data attribute; live refresh
// polls /api/console/network (same-origin, board host-guard). Visual
// grammar shared with the Belt machine map: muted-to-red load, blue active,
// gray unknown — design tokens only.
import { LitElement, html, nothing, type TemplateResult, css } from "lit";
import { cardCss } from "./klh-console-card-css.ts";
import type { NetworkPayload } from "../board/network-overview.ts";
import type {
	NetworkInterfaceRow,
	NetworkOverviewResult,
	NetworkRouteRow,
} from "../../buckle/src/network-read-model.ts";

// token formatting — measured numbers only; null renders "—", never 0
const fmtTok = (n: number | null): string => {
	if (n === null || !Number.isFinite(n)) return "—";
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
};

const fmtAge = (s: number | null): string =>
	s === null ? "unknown" : s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;

/** Edge width by measured 60s output rate (tok/s): 1-4px, thresholds in
 *  the legend; null rate = unknown width 1, gray (never a fake thin edge). */
const edgeWidth = (tokPerS: number | null): number => {
	if (tokPerS === null) return 1;
	if (tokPerS >= 100) return 4;
	if (tokPerS >= 20) return 3;
	if (tokPerS >= 5) return 2;
	return 1;
};

/** The ok:true read-model slice (routes/interfaces/hops derive from it). */
type OkNet = Extract<NetworkOverviewResult, { ok: true }>;

// card-scoped styles over the shared cardCss — design tokens only
const netCss = css`
	.hrow {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: baseline;
		padding: 3px 0;
	}
	.hname {
		min-width: 16ch;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.unknown,
	.legend {
		color: var(--klh-dim);
		font-size: 10.5px;
	}
	.unknown {
		font-style: italic;
	}
	.hot {
		color: var(--klh-danger);
	}
	.live {
		color: var(--klh-accent);
	}
	.hourSeries {
		display: flex;
		align-items: end;
		gap: 3px;
		width: min(360px, 100%);
		height: 42px;
		border-bottom: 1px solid var(--klh-edge-mid);
	}
	.hourBar {
		flex: 1 1 0;
		min-width: 3px;
		background: var(--klh-accent);
	}
	.hourRange {
		width: min(360px, 100%);
		display: flex;
		justify-content: space-between;
		font: var(--klh-text-xs) var(--klh-font-mono);
		color: var(--klh-dim);
	}
`;

const ageS = (iso: string): number =>
	Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

/** The local spoke probe row (#45773): the board's own buckle-4101
 *  monitored-service verdict — state live/hot, detail as-is. */
const spokeRow = (p: NetworkPayload): TemplateResult =>
	p.gateway
		? html`<p>
				<span class="hname">local spoke</span>
				<span class=${p.gateway.state === "up" ? "live" : "hot"}>
					${p.gateway.state}</span
				>
				<span class="unknown">· ${p.gateway.detail}</span>
			</p>`
		: html`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`;

/** Per-hub observed rows (#45792): TTL-bounded active + request/error
 *  counts + observer freshness; empty = no projection db wired here. */
const hubSection = (n: OkNet): TemplateResult => html`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${
			n.hubs.length
				? nothing
				: html`<span class="unknown">no projection db wired here</span>`
		}
	</div>
	${n.hubs.map(
		(h) => html`<div class="hrow">
			<span class="hname">${h.source}</span>
			<span class="num">active ${h.active}</span>
			<span class="num">${h.requests} req</span>
			<span class="num ${h.errors > 0 ? "hot" : ""}">${h.errors} err</span>
			<span class="unknown">obs age ${h.freshness.ageS === null ? "unknown" : `${h.freshness.ageS}s`} · seq ${h.freshness.lastSeq ?? "?"}</span>
		</div>`,
	)}
	${
		n.hops.length
			? html`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${n.hops.map(
					(hp) =>
						html`<span class="num">${hp.origin || "local"} → ${hp.peer} (${hp.n})</span>`,
				)}
			</div>`
			: nothing
	}
	${
		n.unsettled.length
			? html`<div class="hrow">
				<span class="hname">unsettled</span>
				${n.unsettled.map((u) => html`<span class="num">${u.kind}: ${u.n}</span>`)}
			</div>`
			: nothing
	}`;

/** One measured interface row: 60s rate + 15m workload, per-interface
 *  provenance (#45792) with the measured edge bar (1-4px × 14). */
const interfaceRow = (i: NetworkInterfaceRow): TemplateResult => {
	const tokS = i.out60 === null ? null : Math.round(i.out60 / 60);
	return html`<div class="hrow">
		<span class="hname">${i.kind} · ${i.host ?? "unknown"}${i.port ? `:${i.port}` : ""}</span>
		<span class="num">${i.model ?? ""}</span>
		<span class="num">${i.req60} req/60s</span>
		<span class="num ${tokS === null ? "" : tokS >= 100 ? "hot" : "live"}">
			${tokS === null ? "tok/s unknown" : `${tokS} tok/s`}
		</span>
		<span class="num">15m: ${i.req15} req · out ${fmtTok(i.out15)}</span>
		<span
			class="bar"
			style="width:${edgeWidth(tokS) * 14}px;background:var(--klh-edge)"
		></span>
	</div>`;
};

/** One recent successful route (#45790): ts/lane/target provenance +
 *  duration + measured tokens (null → "—", never 0). */
const routeRow = (r: NetworkRouteRow): TemplateResult => html`<div class="hrow">
	<span class="unknown">${r.ts.slice(11, 19)}</span>
	<span class="title">${r.target_model ?? "model unknown"}</span>
	<span class="unknown" title=${r.lane || "No lane attribution"}>${r.lane ? `lane ${r.lane.replace(/^autow([\d.]+)-.*/, "W$1")}` : "unattributed"}</span>
	<span class="num">${r.target_kind ?? "?"} ${r.target_host ?? ""}</span>
	<span class="num">${r.duration_ms === null ? "—" : `${r.duration_ms}ms`}</span>
	<span class="num">in ${fmtTok(r.in_tok)} · out ${fmtTok(r.out_tok)}</span>
</div>`;

const hourLabel = (hour: string): string => {
	const date = new Date(`${hour}:00Z`);
	if (Number.isNaN(date.getTime())) return hour;
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${p(date.getDate())}.${p(date.getMonth() + 1)} ${p(date.getHours())}:00`;
};

/** Window totals (15m, settled usage; COUNT is a true 0, sums stay null)
 *  + a chronological histogram of the last 12 recorded hours. */
const topRows = (n: OkNet): TemplateResult => {
	const b = n.throughput.buckets.slice(0, 12).reverse();
	const maxOut = Math.max(1, ...b.map((x) => x.out_tok));
	const first = b[0];
	const last = b[b.length - 1];
	return html`<p class="hrow">
			<span class="hname">window 15m</span>
			<span class="num">${n.throughput.window.requests} req</span>
			<span class="num">in ${fmtTok(n.throughput.window.in_tok)}</span>
			<span class="num">out ${fmtTok(n.throughput.window.out_tok)} tok</span>
			${
				n.observations.available
					? nothing
					: html`<span class="unknown">observations: not collected here</span>`
			}
		</p>
		<div class="hrow">
			<span class="hname">recorded output · 12h</span>
			<div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${b.map(
						(x) => html`<span class="hourBar"
							style="height:${x.out_tok ? Math.max(2, Math.round((x.out_tok / maxOut) * 40)) : 0}px"
							title="${hourLabel(x.hour)} · ${x.requests} req · out ${fmtTok(x.out_tok)} tok"
						></span>`,
					)}
				</div>
				<div class="hourRange"><span>${first ? hourLabel(first.hour) : ""}</span><span>${last ? hourLabel(last.hour) : ""}</span></div>
			</div>
		</div>`;
};

/** The SSR-seed/live payload → card body. Ledger sections first, observed
 *  hubs second; every empty section says WHY (unwired, no traffic). */
const networkCardRender = (p: NetworkPayload): TemplateResult => {
	const n = p.network;
	if (!n.ok)
		return html`${spokeRow(p)}
			<p class="unknown">${n.reason}</p>`;
	return html`${spokeRow(p)}
		${topRows(n)}
		${hubSection(n)}
		${
			n.throughput.interfaces.length
				? n.throughput.interfaces.map(interfaceRow)
				: html`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`
		}
		${
			n.routes.length
				? n.routes.map(routeRow)
				: html`<div class="hrow">
					<span class="hname">routes</span>
					<span class="unknown">none settled yet</span>
				</div>`
		}
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`;
};

/** One live payload or null (error surfaces as the refresh-failed line). */
const fetchNetwork = async (): Promise<NetworkPayload | null> => {
	try {
		const r = await fetch("/api/console/network", { cache: "no-store" });
		if (!r.ok) return null;
		return (await r.json()) as NetworkPayload;
	} catch {
		return null;
	}
};

class KlhNetworkCard extends LitElement {
	static properties = { heading: { type: String }, data: { type: Object } };
	static styles = [cardCss, netCss];
	declare heading: string;
	declare data: NetworkPayload | null;
	private live: NetworkPayload | null = null;
	private err = "";
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor() {
		super();
		this.heading = "";
		this.data = null;
	}
	connectedCallback() {
		super.connectedCallback();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 10_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.timer) clearInterval(this.timer);
	}
	private async refresh(): Promise<void> {
		const p = await fetchNetwork();
		if (p) {
			this.live = p;
			this.err = "";
		} else this.err = "refresh failed — last known values shown";
	}
	protected render(): TemplateResult {
		const p = this.live ?? this.data;
		if (!p) return html`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;
		const errLine = this.err
			? html`<p class="unknown">${this.err}</p>`
			: nothing;
		return html`<h2>${this.heading} · live ${fmtAge(ageS(p.ts))}</h2>
			${errLine}${networkCardRender(p)}`;
	}
}

customElements.define("klh-network-card", KlhNetworkCard);
