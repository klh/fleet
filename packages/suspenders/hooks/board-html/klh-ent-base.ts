// hooks/board-html/klh-ent-base.ts — W775.1: shared chrome for the
// enterprise panel family. The base owns the panel card (shadow DOM,
// design tokens, status chip, honest states: loading / failed slice
// ok:false / empty), panels own their data (a body() template over
// typed rows). Tokens: the page defines the --klh-ent-* family
// (enterprise plane, violet); the family never hardcodes colors — every
// rule consumes the klh-ent-* custom properties defined in
// hooks/lib/theme.ts.
import { LitElement, css, html, type TemplateResult } from "lit";
import type {
	EntitlementsPayload,
	EnterprisePayload,
	FailedSlice,
} from "../board/ent-seam.ts";

/** The slice union a panel renders; keyed lookup per panel. */
export type EntSlice = NonNullable<
	EnterprisePayload["panels"][keyof EnterprisePayload["panels"]]
>;

/** Entitlements: which panels this board is entitled to render. */
export type EntEntitlements = EntitlementsPayload;

/** A slice that failed (provider said ok:false + why). */
export type EntFailed = FailedSlice;

/** Status chip — tone is one of ok | bad | ent | muted. */
export const chip = (tone: string, text: string): TemplateResult =>
	html`<span class="chip ${tone}">${text}</span>`;

/** ms epoch → mm-dd HH:MM (board-local recent past, no year). */
export const when = (ms: number | null | undefined): string =>
	ms === null || ms === undefined
		? "—"
		: new Date(ms).toISOString().slice(5, 16).replace("T", " ");

/** Token count compacted (1.2M / 340k / 894). */
export const fmtTok = (n: number): string =>
	n >= 1e6
		? `${(n / 1e6).toFixed(1)}M`
		: n >= 1e3
			? `${(n / 1e3).toFixed(0)}k`
			: String(n);

/** Panel identity each subclass pins. */
export interface EntPanelSpec {
	title: string;
	glyph: string;
}

/** The panel card base: chrome + honest states; subclasses supply
 *  body() over their typed slice. */
export class KlhEntPanel extends LitElement {
	static properties = { data: { state: true } };

	static styles = css`
		:host {
			display: block;
			background: var(--klh-surface);
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: var(--klh-radius-lg);
			overflow: hidden;
		}
		header {
			display: flex;
			align-items: baseline;
			padding: var(--klh-space-4) var(--klh-space-5);
			background: var(--klh-ent-accent-bg, var(--klh-surface-hi));
			border-bottom: 1px solid var(--klh-ent-edge, var(--klh-edge));
		}
		header .glyph {
			color: var(--klh-ent-accent, var(--klh-accent));
			font-size: var(--klh-text-lg);
		}
		header h3 {
			margin: 0;
			font-size: var(--klh-text-xl);
			font-weight: 600;
			letter-spacing: 0.03em;
		}
		header .count {
			margin-left: auto;
			font-size: var(--klh-text-sm);
			color: var(--klh-dim);
		}
	`;

	declare data: EntSlice | null;

	protected spec: EntPanelSpec = { title: "panel", glyph: "▪" };

	constructor() {
		super();
		this.data = null;
	}

	/** The card body — rows over the typed slice. */
	protected body(): TemplateResult | null {
		return null;
	}

	/** Rows counter for the header chip (null = hide the chip). */
	protected count(): number | null {
		return null;
	}

	/** The typed slice, null when unset or failed (ok:false). */
	protected sliceOf<T extends { ok: true }>(): T | null {
		if (this.data === null || this.data.ok === false) return null;
		return this.data as unknown as T;
	}

	protected render(): TemplateResult {
		const d = this.data;
		return html`
			<header>
				<span class="glyph" aria-hidden="true">${this.spec.glyph}</span>
				<h3>${this.spec.title}</h3>
				<span class="count">${this.chipText()}</span>
			</header>
			<div class="body">
				${
					d === null
						? html`<div class="state">waiting for entitlements…</div>`
						: d.ok === false
							? html`<div class="state bad">${d.why}</div>`
							: (this.body() ?? html`<div class="state">no data yet</div>`)
				}
			</div>
		`;
	}

	private chipText(): string {
		if (this.data === null) return "";
		if (this.data.ok === false) return "unavailable";
		const n = this.count();
		return n === null ? "" : String(n);
	}
}
