// hooks/board-html/klh-conn-banner.ts — the header connection banner as a
// stateless Lit leaf: it renders the `verdict` the mediator hands down
// (conn-verdict.ts — live / stale / error, decisions freshness, provenance
// title) and asks for a refetch with a FeedRefreshRequestedEvent. It never
// fetches, never reads the store. Bundled with klh-board-mediator.js.
import { LitElement, css, html, nothing } from "lit";
import { FeedRefreshRequestedEvent } from "./board-events.ts";
import type { ConnVerdict } from "./conn-verdict.ts";

export class KlhConnBanner extends LitElement {
	static properties = { verdict: { attribute: false } };

	declare verdict: ConnVerdict | null;

	static styles = css`
		:host {
			font-size: 11px;
			color: var(--klh-dim);
			white-space: nowrap;
		}
		.dot {
			display: inline-block;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			margin-right: 5px;
			vertical-align: 0;
		}
		.dot.live {
			background: var(--klh-ok);
		}
		.dot.stale {
			background: var(--klh-accent);
		}
		.dot.err {
			background: var(--klh-danger);
		}
		.retry {
			background: none;
			border: 1px solid var(--klh-danger);
			color: var(--klh-danger-ink);
			border-radius: 2px;
			font: inherit;
			font-size: 10px;
			padding: 1px 8px;
			cursor: pointer;
			margin-left: 8px;
		}
	`;

	constructor() {
		super();
		this.verdict = null;
	}

	private retry(): void {
		this.dispatchEvent(new FeedRefreshRequestedEvent("data"));
	}

	protected updated(): void {
		this.title = this.verdict ? this.verdict.title : "";
	}

	protected render() {
		const v = this.verdict;
		if (!v) return html`<span class="dot stale"></span>connecting`;
		return html`<span class="dot ${v.cls}"></span>${v.txt}
			<span class="dim">| ${v.dec}</span>${
				v.retry
					? html` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`
					: nothing
			}`;
	}
}

if (!customElements.get("klh-conn-banner"))
	customElements.define("klh-conn-banner", KlhConnBanner);
