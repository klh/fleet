// hooks/board-html/klh-gateway-flow-card.ts — W2673.2: the live gateway flow
// card on /console/buckle (the AI-Gateway-style view). Three columns —
// senders LEFT (lane/actor + live counts), the gateway node CENTER with
// req/s + the 30s series sparkline, targets RIGHT grouped MODELS /
// UPSTREAMS — joined by measured edges (width = share of window requests).
// Window selector 1/5/10 min; Live/Pause toggle (pause freezes the payload,
// the cycle keeps ticking); legend: dashed = companion lane, dotted =
// unattributed; orange dot = masked by guardrail, red dot = blocked at
// gateway; hover a node or edge to trace the request path. 'Needs
// attention' cards render from the feed's own rows and the coverage block
// reports truncation honestly. Rides the W2673.1 feed
// (GET /api/console/flow?window=60|300|600) via the board volatile-refresh
// poll pattern (the klh-network-card precedent). Design tokens only.
import type {
	FlowAttentionRow,
	FlowResult,
	FlowSenderRow,
	FlowTargetRow,
} from "@klh/buckle/src/flow-read-model.ts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { cardCss } from "./klh-console-card-css.ts";

/** The wire payload (ok:false carries the reason — rendered, never hidden). */
type FlowPayload = FlowResult;

const WINDOWS: Array<{ value: string; label: string }> = [
	{ value: "60", label: "1 min" },
	{ value: "300", label: "5 min" },
	{ value: "600", label: "10 min" },
];

/** The right column's grouping — the feed's own two kinds (model vs
 *  upstream host); anything else still surfaces under its own heading. */
const TARGET_GROUPS: Array<{ heading: string; kind: "model" | "upstream" }> = [
	{ heading: "MODELS", kind: "model" },
	{ heading: "UPSTREAMS", kind: "upstream" },
];

/** autow2673-2-p98b319584008df14 → W2673.2 (the board's lane vocabulary). */
const laneShort = (lane: string): string =>
	lane.replace(/^autow([\d.]+)-.*/, "W$1");

const fetchFlow = async (windowS: string): Promise<FlowPayload | null> => {
	try {
		const r = await fetch(`/api/console/flow?window=${windowS}`, {
			cache: "no-store",
		});
		if (!r.ok) return null;
		return (await r.json()) as FlowPayload;
	} catch {
		return null;
	}
};

class KlhGatewayFlowCard extends LitElement {
	static properties = {
		heading: { type: String },
		src: { type: String },
		paused: { type: Boolean },
	};
	static styles = [
		cardCss,
		css`
			.bar {
				display: flex;
				gap: var(--klh-space-4);
				flex-wrap: wrap;
				align-items: baseline;
				margin: 0 0 var(--klh-space-3);
			}
			.bar h2 {
				margin: 0;
			}
			.bar .spacer {
				flex: 1 1 auto;
			}
			label.win {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
				text-transform: uppercase;
				letter-spacing: 0.06em;
			}
			select {
				background: var(--klh-bg);
				color: var(--klh-ink);
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				font: var(--klh-text-md) var(--klh-font-mono);
				padding: 2px 6px;
			}
			button.live {
				border: 1px solid var(--klh-edge-strong);
				border-radius: 2px;
				background: var(--klh-bg);
				color: var(--klh-ink);
				font: 600 var(--klh-text-xs) var(--klh-font-sans);
				text-transform: uppercase;
				letter-spacing: 0.06em;
				padding: 4px 12px;
				cursor: pointer;
			}
			button.live[aria-pressed="true"] {
				border-color: var(--klh-accent);
				color: var(--klh-accent);
			}
			.flow {
				display: grid;
				grid-template-columns: minmax(150px, 1fr) minmax(110px, auto) minmax(
						150px,
						1fr
					);
				gap: var(--klh-space-4);
				align-items: start;
			}
			.colTitle {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
				text-transform: uppercase;
				letter-spacing: 0.08em;
				border-bottom: 1px solid var(--klh-rule);
				padding-bottom: var(--klh-space-2);
				margin: 0 0 var(--klh-space-2);
			}
			.node {
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				background: var(--klh-surface);
				padding: var(--klh-space-2) var(--klh-space-3);
				margin-bottom: var(--klh-space-2);
				font-size: var(--klh-text-md);
			}
			.node:focus-visible {
				outline: 2px solid var(--klh-accent);
				outline-offset: 2px;
			}
			.node .who {
				font-family: var(--klh-font-mono);
				word-break: break-all;
			}
			.node .count {
				font-variant-numeric: tabular-nums;
				color: var(--klh-ink-2);
			}
			.node .err {
				color: var(--klh-danger-ink);
			}
			.node.gatewayNode {
				border-color: var(--klh-edge-strong);
				text-align: center;
				padding: var(--klh-space-4) var(--klh-space-3);
			}
			.node.gatewayNode .rate {
				font-size: 20px;
				font-weight: 600;
				font-variant-numeric: tabular-nums;
			}
			.node.gatewayNode .sub {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
			}
			.spark {
				display: block;
				width: 100%;
				height: 28px;
				margin-top: var(--klh-space-2);
			}
			.edge {
				height: 5px;
				margin: 0 0 var(--klh-space-2);
				border-radius: 2px;
				background: var(--klh-edge);
			}
			.edge.api_key {
				background: var(--klh-edge-strong);
			}
			.edge.companion {
				background: repeating-linear-gradient(
					to right,
					var(--klh-edge-strong) 0 6px,
					transparent 6px 10px
				);
			}
			.edge.internal {
				background: repeating-linear-gradient(
					to right,
					var(--klh-edge) 0 2px,
					transparent 2px 7px
				);
			}
			.dot {
				display: inline-block;
				width: 8px;
				height: 8px;
				border-radius: 50%;
				margin-right: 5px;
				vertical-align: baseline;
			}
			.dot.masked {
				background: var(--klh-accent);
			}
			.dot.blocked {
				background: var(--klh-danger);
			}
			.legend {
				color: var(--klh-dim);
				font-size: 10.5px;
				margin-top: var(--klh-space-3);
			}
			.attn {
				border: 1px solid var(--klh-danger-edge);
				background: var(--klh-danger-wash);
				border-radius: 2px;
				padding: var(--klh-space-2) var(--klh-space-3);
				margin: var(--klh-space-2) 0;
				font-size: var(--klh-text-md);
			}
			.attn b {
				color: var(--klh-danger-ink);
			}
			.attn .sub {
				color: var(--klh-ink-2);
				font-size: var(--klh-text-sm);
			}
			.attn.kind_masked {
				border-color: var(--klh-accent-dim);
				background: var(--klh-accent-wash);
			}
			.empty {
				color: var(--klh-dim);
				font-size: var(--klh-text-sm);
				font-style: italic;
			}
			@media (max-width: 760px) {
				.flow {
					grid-template-columns: 1fr;
				}
			}
		`,
	];

	declare heading: string;
	/** Initial window (the SSR seed's), overridden by user selection. */
	declare src: string;
	/** Pause freezes the payload; the poll cycle keeps ticking (reactive —
	 *  the button's aria-pressed renders from it). */
	declare paused: boolean;
	private live: FlowPayload | null = null;
	private err = "";
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.heading = "Gateway flow";
		this.src = "300";
		this.paused = false;
	}

	connectedCallback(): void {
		super.connectedCallback();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 5_000);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.timer) clearInterval(this.timer);
	}

	private async refresh(): Promise<void> {
		if (this.paused) return;
		const p = await fetchFlow(this.src);
		if (p) {
			this.live = p;
			this.err = "";
		} else this.err = "refresh failed — last known values shown";
		this.requestUpdate();
	}

	private selectWindow(e: Event): void {
		this.src = (e.target as HTMLSelectElement).value;
		void this.refresh();
	}

	private togglePause(): void {
		this.paused = !this.paused;
		if (!this.paused) void this.refresh();
	}

	protected render(): TemplateResult {
		const p = this.live;
		const errLine = this.err
			? html`<p class="dimpl" role="alert">${this.err}</p>`
			: nothing;
		if (!p)
			return html`<h2>${this.heading}</h2>
				<p class="dimpl">loading…</p>`;
		if (!p.ok)
			return html`<h2>${this.heading}</h2>
				${errLine}<div class="errbox">${p.reason}</div>`;
		return html`<h2>${this.heading} · window ${p.windowS / 60}m · ${p.senders.length} senders</h2>
			<div class="bar">
				<label class="win">window
					<select
						aria-label="flow window"
						@change=${this.selectWindow}
					>
						${WINDOWS.map(
							(w) =>
								html`<option value=${w.value} ?selected=${w.value === this.src}>${w.label}</option>`,
						)}
					</select>
				</label>
				<button
					type="button"
					class="live"
					aria-pressed=${this.paused ? "false" : "true"}
					@click=${this.togglePause}
				>
					${this.paused ? "resume" : "live"}
				</button>
				<span class="spacer"></span>
				<span class="dimpl">since ${p.windowStart.slice(11, 19)}Z</span>
			</div>
			${errLine}
			${this.attention(p.attention)}
			<div class="flow">
				<div>
					<p class="colTitle">Senders</p>
					${
						p.senders.length
							? p.senders.map((s) => this.senderNode(s, p.gateway.requests))
							: html`<p class="empty">no requests in window</p>`
					}
				</div>
				<div>
					<p class="colTitle">Gateway</p>
					<div
						class="node gatewayNode"
						title=${`${p.gateway.requests} requests · ${p.gateway.errors} errors · ${p.gateway.active} active (admitted, not ended) · window ${p.windowS / 60}m since ${p.windowStart}`}
					>
						<div class="rate">${p.gateway.reqPerS}<span class="sub"> req/s</span></div>
						<div class="count">${p.gateway.requests} req</div>
						<div class="count">${p.gateway.active} active</div>
						${
							p.gateway.errors
								? html`<div class="count err">${p.gateway.errors} err</div>`
								: nothing
						}
						${this.sparkline(p.gateway.series)}
					</div>
				</div>
				<div>
					<p class="colTitle">Targets</p>
					${this.targets(p.targets)}
				</div>
			</div>
			${this.coverage(p)}
			<p class="legend">
				edge: solid = named lane · dashed = companion · dotted = unattributed —
				width = share of window requests · <span class="dot masked"></span>masked
				by guardrail · <span class="dot blocked"></span>blocked at gateway ·
				hover a node for its trace
			</p>`;
	}

	/** One sender row + its measured edge toward the gateway. */
	private senderNode(s: FlowSenderRow, total: number): TemplateResult {
		const who = s.lane
			? laneShort(s.lane)
			: s.actor
				? `actor ${s.actor.slice(0, 8)}`
				: "internal";
		const share = total > 0 ? Math.max(6, (s.requests / total) * 100) : 6;
		const cls = s.lane
			? s.lane.startsWith("autow")
				? "companion"
				: "api_key"
			: "internal";
		const trace = [
			`${s.lane || "(no lane)"}`,
			`${s.requests} requests · ${s.errors} errors · ${s.active} active`,
			`${s.reqPerS} req/s`,
			`last ${new Date(s.lastAt).toISOString().slice(11, 19)}Z`,
		].join(" · ");
		return html`<div class="node" title=${trace} tabindex="0">
				<span class="who">${who}</span>
				<span class="count"> ${s.requests} req</span>
				${
					s.active
						? html`<span class="count"> · ${s.active} active</span>`
						: nothing
				}
				${
					s.errors
						? html`<span class="count err"> · ${s.errors} err</span>`
						: nothing
				}
			</div>
			<div
				class="edge ${cls}"
				title=${`${who} → gateway · ${share.toFixed(0)}% of window requests`}
			></div>`;
	}

	/** The grouped right column — the feed's two kinds as headings;
	 *  anything else keeps its own heading (never dropped, never mis-filed). */
	private targets(rows: FlowTargetRow[]): TemplateResult {
		if (!rows.length)
			return html`<p class="empty">
				no attributed targets in window (no ledger join rows)
			</p>`;
		const groups = TARGET_GROUPS.map((g) => ({
			heading: g.heading,
			mine: rows.filter((r) => r.kind === g.kind),
		})).filter((g) => g.mine.length);
		const rest = rows.filter(
			(r) => r.kind !== "model" && r.kind !== "upstream",
		);
		const all = rest.length
			? [...groups, { heading: "OTHER", mine: rest }]
			: groups;
		return html`${all.map(
			(g) => html`<p class="colTitle">${g.heading}</p>
				${g.mine.map((r) => this.targetNode(r))}`,
		)}`;
	}

	private targetNode(r: FlowTargetRow): TemplateResult {
		const trace = `${r.kind} · ${r.name} · ${r.requests} requests · ${r.errors} errors · ${r.reqPerS} req/s · last ${r.lastAt.slice(11, 19)}Z`;
		return html`<div class="node" title=${trace} tabindex="0">
			<span class="who">${r.name}</span>
			<span class="count"> ${r.requests} req</span>
			${
				r.errors
					? html`<span class="count err"> · ${r.errors} err</span>`
					: nothing
			}
		</div>`;
	}

	/** 'Needs attention' cards — the feed's own rows, styled by kind. */
	private attention(rows: FlowAttentionRow[]): TemplateResult {
		if (!rows.length)
			return html`<p class="dimpl">no attention signals in window</p>`;
		return html`${rows.map(
			(a) => html`<div class="attn kind_${a.kind}">
				<b>${a.subject}</b>
				<div class="sub">${a.detail} (${a.n})</div>
			</div>`,
		)}`;
	}

	/** The 30s-bucket series as an inline SVG sparkline (the center node's
	 *  live pulse). null = no events — omitted, never a fake flat line. */
	private sparkline(
		series: Array<{ t: number; requests: number }> | null,
	): TemplateResult {
		if (!series?.length) return html`${nothing}`;
		const max = Math.max(...series.map((b) => b.requests), 1);
		const w = 100;
		const h = 24;
		const step = w / Math.max(series.length - 1, 1);
		const pts = series
			.map(
				(b, i) =>
					`${(i * step).toFixed(1)},${(h - (b.requests / max) * (h - 2) - 1).toFixed(1)}`,
			)
			.join(" ");
		const latest = series[series.length - 1];
		return html`<svg
			class="spark"
			viewBox="0 0 ${w} ${h}"
			preserveAspectRatio="none"
			role="img"
			aria-label=${`requests per 30s over the window, latest ${latest.requests}`}
		>
			<polyline
				fill="none"
				stroke="var(--klh-accent)"
				stroke-width="1.5"
				points=${pts}
			/>
		</svg>`;
	}

	/** Coverage honesty line — truncation and db halves report, never hide. */
	private coverage(p: FlowPayload & { ok: true }): TemplateResult {
		const c = p.coverage;
		const bits: string[] = [];
		if (!c.projectionAvailable) bits.push("projection db unavailable");
		if (!c.ledgerAvailable)
			bits.push("ledger unavailable — targets unattributed");
		if (c.sendersTruncated > 0)
			bits.push(`${c.sendersTruncated} senders past cap`);
		if (c.targetsTruncated > 0)
			bits.push(`${c.targetsTruncated} targets past cap`);
		if (!bits.length) return html`${nothing}`;
		return html`<p class="legend" role="note">${bits.join(" · ")}</p>`;
	}
}

if (!customElements.get("klh-gateway-flow-card"))
	customElements.define("klh-gateway-flow-card", KlhGatewayFlowCard);
