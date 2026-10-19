// hooks/board-html/klh-console-cards.ts — W669.11: the console page data
// cards (routing policy, upstream pool, .local registry, board knobs, admin
// audit) as Lit shadow-DOM components (UI law). The W184 staged migration's
// last server-side string panels outside the board SPA: pages emit static
// hosts + esc(JSON) data attributes (the klh-service-row pattern) and the
// cards render tokens-styled shadow DOM. Built by `bun run build:vendor` to
// vendor/klh-console-cards.js — offline, never CDN. Type-only exports are
// the server↔component seam (erased at bundle time).
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { cardCss } from "./klh-console-card-css.ts";
// W858.10.3 — the Network overview card defines <klh-network-card> (same
// bundle, no new allowlist entry; its type imports are erased at bundle time)
import "./klh-network-card.ts";

// interleaves separator strings between rendered parts (flatMap, never
// nested arrays — the parts array goes straight into lit-html)
const joinSep = (parts: TemplateResult[], sep: string): TemplateResult[] =>
	parts.flatMap((p, i) => (i ? [html`${sep}`, p] : [p]));

// ─── <klh-policy-card> — routing policy (belt full / index summary) ───────
class KlhPolicyCard extends LitElement {
	static properties = {
		heading: { type: String },
		compact: { type: Boolean },
		foot: { type: String },
		data: { type: Object },
	};
	static styles = [cardCss];

	declare heading: string;
	declare compact: boolean;
	declare foot: string;
	declare data: PolicyCardData | null;

	constructor() {
		super();
		this.heading = "";
		this.compact = false;
		this.foot = "";
		this.data = null;
	}

	protected render(): TemplateResult {
		const d = this.data;
		if (!d) return html`${nothing}`;
		if (d.kind === "missing")
			return html`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;
		if (d.kind === "no-gateway")
			return html`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;
		if (d.kind === "error")
			return html`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${d.path} does not parse: ${d.error}
				</div>`;
		const g = d.gateway;
		return html`<h2>${this.head(d.path, d.source)}</h2>
			${
				g
					? html`
						<div class="knobs">
							<span class="kchip">num_retries: <b>${g.num_retries}</b></span>
							<span class="kchip">
								allowed_fails: <b>${g.allowed_fails}</b>
							</span>
							<span class="kchip">
								cooldown_time: <b>${g.cooldown_time}s</b>
							</span>
						</div>
						${this.compact ? nothing : this.ladder(g.fallbacks)}
					`
					: nothing
			}${this.foot ? html`<p class="cfoot">${this.foot}</p>` : nothing}`;
	}

	// " · path · source: X" suffix (top-level templates only)
	private head(path: string, source: string): string {
		let h = this.heading;
		if (path) h += ` · ${path}`;
		if (source) h += ` · source: ${source}`;
		return h;
	}

	private ladder(fallbacks: Record<string, string[]>): TemplateResult {
		const entries = Object.entries(fallbacks);
		if (this.compact && entries.length)
			return html`<span class="kchip">
				ladder: <b>${joinSep(this.chips(entries), " · ")}</b>
			</span>`;
		if (this.compact) return html`${nothing}`;
		return html`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${entries.map(
					(e) => html`<tr>
						<td><b>${e[0]}</b></td>
						<td>${joinSep(this.pills(e[1]), " → ")}</td>
					</tr>`,
				)}
			</tbody>
		</table>`;
	}

	private chips(entries: [string, string[]][]): TemplateResult[] {
		return entries.map((e) => html`${e[0]} → ${e[1].length} tiers`);
	}

	private pills(tiers: string[]): TemplateResult[] {
		return tiers.map((t, i) => html`<span class="pill">${i + 1}. ${t}</span>`);
	}
}

if (!customElements.get("klh-policy-card"))
	customElements.define("klh-policy-card", KlhPolicyCard);

// ─── <klh-upstreams-card> — configured upstream pool table ────────────────
class KlhUpstreamsCard extends LitElement {
	static properties = {
		heading: { type: String },
		data: { type: Object },
	};
	static styles = [cardCss];

	declare heading: string;
	declare data: UpstreamsCardData | null;

	constructor() {
		super();
		this.heading = "Configured upstream pool";
		this.data = null;
	}

	protected render(): TemplateResult {
		const d = this.data;
		if (!d) return html`${nothing}`;
		if (!d.groups)
			return html`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;
		return html`<h2>${this.heading} · ${d.source}</h2>${this.table(d.groups)}`;
	}

	private table(groups: UpstreamGroupRow[]): TemplateResult {
		return html`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${groups.map((g) => this.row(g))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`;
	}

	private row(g: UpstreamGroupRow): TemplateResult {
		const state = g.dormant
			? html`<span class="dimpl">dormant</span>`
			: html`<span>configured</span>`;
		return html`<tr>
			<td><b>${g.name}</b></td>
			<td class="num">${g.tiers}</td>
			<td>${state}</td>
			<td>${g.source}</td>
		</tr>`;
	}
}

if (!customElements.get("klh-upstreams-card"))
	customElements.define("klh-upstreams-card", KlhUpstreamsCard);

// ─── <klh-registry-card> — the registered .local services table ───────────
class KlhRegistryCard extends LitElement {
	static properties = {
		heading: { type: String },
		data: { type: Object },
	};
	static styles = [cardCss];

	declare heading: string;
	declare data: RegistryCardData | null;

	constructor() {
		super();
		this.heading = "Registered services";
		this.data = null;
	}

	protected render(): TemplateResult {
		const d = this.data;
		if (!d) return html`${nothing}`;
		return html`<h2>${this.heading}</h2>${this.body(d)}`;
	}

	private body(d: RegistryCardData): TemplateResult {
		return html`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${d.rows.map((r) => this.row(r))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`;
	}

	private row(r: RegistryRow): TemplateResult {
		return html`<tr>
			<td><a href="https://${r.name}.local/">${r.name}.local</a></td>
			<td><span class="pill">${r.scope}</span></td>
			<td class="mono">${r.upstream}</td>
			<td>${r.monitored}</td>
		</tr>`;
	}
}

if (!customElements.get("klh-registry-card"))
	customElements.define("klh-registry-card", KlhRegistryCard);

// ─── <klh-knobs-card> — the suspenders-board.json knobs card ──────────────
class KlhKnobsCard extends LitElement {
	static properties = {
		heading: { type: String },
		data: { type: Object },
	};
	static styles = [cardCss];

	declare heading: string;
	declare data: KnobsCardData | null;

	constructor() {
		super();
		this.heading = "suspenders-board.json";
		this.data = null;
	}

	protected render(): TemplateResult {
		const d = this.data;
		if (!d) return html`${nothing}`;
		return html`<h2>${this.heading}</h2>${this.body(d)}`;
	}

	private body(d: KnobsCardData): TemplateResult {
		if (d.error)
			return html`<div class="errbox">
				current file does not parse: ${d.error}
			</div>`;
		return html`<div class="knobs">
			${d.knobs.map(
				(n) => html`<span class="kchip">${n.k}: <b>${n.v}</b></span>`,
			)}
		</div>`;
	}
}

if (!customElements.get("klh-knobs-card"))
	customElements.define("klh-knobs-card", KlhKnobsCard);

// ─── <klh-audit-list> — the admin audit trail (W174) ──────────────────────
class KlhAuditList extends LitElement {
	static properties = {
		heading: { type: String },
		data: { type: Object },
	};
	static styles = [cardCss];

	declare heading: string;
	declare data: AuditListData | null;

	constructor() {
		super();
		this.heading = "admin audit";
		this.data = null;
	}

	protected render(): TemplateResult {
		const d = this.data;
		if (!d) return html`${nothing}`;
		if (!d.rows.length)
			return html`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;
		return html`<h2>${this.heading}</h2>
			${d.rows.map((r) => this.chip(r))}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`;
	}

	// one block-mode chip: <b>action</b> · actor · when · target · detail
	private chip(r: AuditRow): TemplateResult {
		const target = r.target ? ` · ${r.target}` : "";
		const detail = r.detail ? ` · ${r.detail}` : "";
		return html`<div class="kchip block">
			<b>${r.action}</b> · ${r.actor} · <span class="mono">${r.when}</span
			>${target}${detail}
		</div>`;
	}
}

if (!customElements.get("klh-audit-list"))
	customElements.define("klh-audit-list", KlhAuditList);

// ─── server↔component seam (display-shaped slices) ───────────────────────
export interface PolicyGatewaySlice {
	num_retries: number;
	allowed_fails: number;
	cooldown_time: number;
	fallbacks: Record<string, string[]>;
}

export type PolicyCardData =
	| { kind: "missing" }
	| { kind: "error"; path: string; error: string }
	| { kind: "no-gateway" }
	| {
			kind: "policy";
			path: string;
			source: string;
			gateway: PolicyGatewaySlice | null;
	  };

export interface UpstreamGroupRow {
	name: string;
	tiers: number;
	dormant: boolean;
	source: string;
}

export interface UpstreamsCardData {
	source: string;
	groups: UpstreamGroupRow[] | null;
}

export interface RegistryRow {
	name: string;
	scope: string;
	upstream: string;
	monitored: string;
}

export interface RegistryCardData {
	rows: RegistryRow[];
}

export interface KnobsCardData {
	error: string | null;
	knobs: { k: string; v: string }[];
}
export interface AuditRow {
	action: string;
	actor: string;
	when: string;
	target: string;
	detail: string;
}
export interface AuditListData {
	rows: AuditRow[];
}
