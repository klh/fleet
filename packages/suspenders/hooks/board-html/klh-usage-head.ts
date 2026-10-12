// hooks/board-html/klh-usage-head.ts — W695.3.5: the usage-dashboard page head
// (title, back link + note, window filter chips) as a Lit component. The SSR
// emitters stopped string-building this chrome per request: they shape a
// `head` slice into the #usage-data payload and emit one <klh-usage-head>
// host. Shadow DOM, --klh-* tokens, lit-html templates only. Bundled with
// usage-panels.js (imported there), so no extra vendor entry or page script.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

export interface UsageHeadOption {
	label: string;
	href: string;
	on: boolean;
}
export interface UsageHeadGroup {
	label: string;
	options: UsageHeadOption[];
}
export interface UsageHead {
	title: string;
	backHref: string;
	backLabel: string;
	note: { text: string; kind: "win" | "on" };
	filters: UsageHeadGroup[];
}

const readHead = (): UsageHead | null => {
	const el = document.getElementById("usage-data");
	if (!el) return null;
	try {
		const p = JSON.parse(el.textContent ?? "") as { head?: UsageHead };
		return p.head ?? null;
	} catch {
		return null;
	}
};

export class KlhUsageHead extends LitElement {
	static properties = { head: { type: Object, state: true } };

	declare head: UsageHead | null;

	constructor() {
		super();
		this.head = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.head = readHead();
	}

	protected render(): TemplateResult | typeof nothing {
		const h = this.head;
		if (h === null) return nothing;
		return html`<h1 class="utitle">${h.title}</h1>
			<div class="uback">
				<a href=${h.backHref}>&larr; ${h.backLabel}</a>
				<span class=${h.note.kind === "on" ? "uon" : "uwin"}
					>${h.note.text}</span
				>
			</div>
			<div class="ufilters">
				${h.filters.map(
					(g) => html`<span class="ufgroup" data-label=${g.label}>
						${g.options.map(
							(o) =>
								html`<a class=${o.on ? "ufilter on" : "ufilter"} href=${o.href}
									>${o.label}</a
								>`,
						)}
					</span>`,
				)}
			</div>`;
	}
}

KlhUsageHead.styles = css`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #e0a458);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #e0a458);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 12px 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on {
		color: var(--klh-accent, #e0a458);
		border-color: var(--klh-accent, #e0a458);
	}
`;

customElements.define("klh-usage-head", KlhUsageHead);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-head": KlhUsageHead;
	}
}
