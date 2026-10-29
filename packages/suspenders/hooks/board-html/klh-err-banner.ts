// hooks/board-html/klh-err-banner.ts — the inline feed-failure banner as a
// stateless Lit leaf (replaces the legacy errBanner/clearErr string helper).
// Data down: the owner sets `text` ('' = hidden; the last good data stays
// visible beside it). Events up: retry asks the mediator to refetch the
// `feed` attribute (FeedRefreshRequestedEvent); a banner with no feed is a
// local error (orchestrate) and asks its owner to dismiss it instead.
import { LitElement, css, html } from "lit";
import {
	ErrorDismissRequestedEvent,
	FeedRefreshRequestedEvent,
} from "./board-events.ts";

/** The one retry-button look (conn banner + err banners). */
export const retryButtonStyles = css`
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

export class KlhErrBanner extends LitElement {
	static properties = {
		text: { type: String },
		feed: { type: String, reflect: true },
	};

	declare text: string;
	declare feed: string;

	static styles = [
		css`
			:host([hidden]) {
				display: none;
			}
		`,
		retryButtonStyles,
	];

	constructor() {
		super();
		this.text = "";
		this.feed = "";
	}

	protected willUpdate(): void {
		this.hidden = !this.text;
	}

	private retry(): void {
		this.dispatchEvent(
			this.feed
				? new FeedRefreshRequestedEvent(this.feed)
				: new ErrorDismissRequestedEvent(this.id),
		);
	}

	protected render() {
		return html`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`;
	}
}

if (!customElements.get("klh-err-banner"))
	customElements.define("klh-err-banner", KlhErrBanner);

declare global {
	interface HTMLElementTagNameMap {
		"klh-err-banner": KlhErrBanner;
	}
}
