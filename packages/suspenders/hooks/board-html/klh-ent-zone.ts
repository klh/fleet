// hooks/board-html/klh-ent-zone.ts — W775.1: the enterprise board zone.
// Lit component; probes /api/entitlements at connect (and every 60s while
// inactive): 501 = Core SKU → the zone renders nothing and no tab
// appears. Entitled → dispatches `ent-entitled` (the SPA registers the
// tab), polls /api/enterprise every 15s and renders the entitled panels
// in a visibly separated zone (own accent tokens --klh-ent-*, defined by
// the page). Panels are family members sharing KlhEntPanel chrome.
import { LitElement, css, html, type TemplateResult } from "lit";
import { ENT_PANEL_KEYS, type EntPanelKey } from "../board/ent-seam.ts";
import type {
	EntEntitlements,
	EntSlice,
	EntSlices,
} from "./klh-ent-base.ts";
import { when } from "./klh-ent-base.ts";
// family members self-register at import — the bundle entry mounts the
// zone, the import mounts the panels
import "./klh-ent-panels.ts";

/** Render order = contract order (ENT_PANEL_KEYS); the panel-tag switch
 *  in #panel() owns the element names. Family members self-register at
 *  import (klh-ent-panels.ts). */
const PANELS: ReadonlyArray<EntPanelKey> = ENT_PANEL_KEYS;

/** The zone: probe → gate → grid. Renders nothing until entitled. */
export class KlhEntZone extends LitElement {
	static properties = {
		active: { type: Boolean, reflect: true },
		ent: { state: true },
		slices: { state: true },
		stamp: { state: true },
	};

	static styles = css`
		:host {
			display: block;
		}
		:host(:not([active])) {
			display: none;
		}
		.zone {
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: var(--klh-radius-lg);
		}
		.zhead {
			display: flex;
			align-items: baseline;
			gap: var(--klh-space-4);
			padding: var(--klh-space-4) var(--klh-space-5);
			background: var(--klh-ent-accent-wash, transparent);
		}
		.badge {
			font-size: var(--klh-text-xs);
			font-weight: 700;
			letter-spacing: 0.12em;
			color: var(--klh-ent-accent, var(--klh-accent));
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: 8px;
			padding: 0 var(--klh-space-3);
		}
		.tenant,
		.stamp {
			font-size: var(--klh-text-xs);
			color: var(--klh-dim);
		}
		.stamp {
			margin-left: auto;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
			gap: var(--klh-space-4);
			padding: var(--klh-space-4);
		}
	`;

	declare active: boolean;
	declare ent: EntEntitlements | null;
	declare slices: EntSlices | null;
	declare stamp: number | null;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.active = false;
		this.ent = null;
		this.slices = null;
		this.stamp = null;
	}

	#refresh(): void {
		fetch("/api/enterprise")
			.then((r) => (r.status === 200 ? r.json() : null))
			.then((j) => {
				if (j === null || j.ok !== true) return;
				this.slices = j.panels as EntSlices;
				this.stamp = Date.now();
			})
			.catch(() => {});
	}

	#entitled(j: EntEntitlements | null): void {
		if (j === null || j.ok !== true) return;
		this.ent = j;
		this.active = true;
		this.dispatchEvent(
			new CustomEvent("ent-entitled", { bubbles: true, composed: true }),
		);
		this.#refresh();
		this.#timer = setInterval(() => {
			this.#refresh();
		}, 60000);
	}

	#probe(): void {
		fetch("/api/entitlements")
			.then((r) => (r.status === 200 ? r.json() : null))
			.then((j) => this.#entitled(j as EntEntitlements | null))
			.catch(() => {});
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.#probe();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	#panel(key: EntPanelKey, s: EntSlice | undefined): TemplateResult {
		const d: EntSlice =
			s ?? ({ ok: false, why: "waiting for first refresh…" } as EntSlice);
		switch (key) {
			case "identity":
				return html`<klh-ent-identity .data=${d}></klh-ent-identity>`;
			case "federation":
				return html`<klh-ent-federation .data=${d}></klh-ent-federation>`;
			case "audit":
				return html`<klh-ent-audit .data=${d}></klh-ent-audit>`;
			case "usage":
				return html`<klh-ent-usage .data=${d}></klh-ent-usage>`;
			case "policy":
				return html`<klh-ent-policy .data=${d}></klh-ent-policy>`;
			case "vault":
				return html`<klh-ent-vault .data=${d}></klh-ent-vault>`;
			case "ma":
				return html`<klh-ent-ma .data=${d}></klh-ent-ma>`;
		}
	}

	protected render(): TemplateResult {
		if (!this.active) return html``;
		const entitled = new Set(this.ent?.panels ?? []);
		const shown = PANELS.filter((k) => entitled.has(k));
		const tenant = this.ent?.tenant ?? "";
		const stamp = this.stamp === null ? "" : when(this.stamp);
		return html`
			<div class="zone">
				<div class="zhead">
					<span class="badge">ENTERPRISE</span>
					<span class="tenant">${tenant}</span>
					<div class="stamp">${stamp}</div>
				</div>
			</div>
			<div class="grid">
				${shown.map((k) => this.#panel(k, this.slices?.[k]))}
			</div>
		`;
	}
}

if (!customElements.get("klh-ent-zone"))
	customElements.define("klh-ent-zone", KlhEntZone);