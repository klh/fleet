// hooks/board-html/klh-board-mediator.ts — THE board mediator (engineering
// standard: events up, data down). It owns the page-wide FeedStore (adopting
// the instance the legacy chunk scope created, or creating it first), installs
// the zod feed contracts as store validators, subscribes to the feeds its
// slotted leaves render, and hands each leaf its slice as a property. Leaves
// never fetch: they dispatch typed BoardEvents, which the mediator handles
// and stops here. Light-DOM children stay where the page put them
// (display: contents), so ids and page CSS keep working.
import { LitElement, css, html } from "lit";
import { embedDualStamp } from "../lib/wallclock.ts";
import { FeedRefreshRequestedEvent } from "./board-events.ts";
import { ago } from "./board-format.ts";
import { type Observation, connVerdict } from "./conn-verdict.ts";
import { FEED_SCHEMAS, feedValidator } from "./feed-schemas.ts";
import { type FeedState, FeedStore } from "./feed-store.ts";
import "./klh-conn-banner.ts";
import "./klh-err-banner.ts";
import type { KlhConnBanner } from "./klh-conn-banner.ts";

declare global {
	var klhFeeds: FeedStore | undefined;
}

/** The one page-wide store, whichever script reaches it first. */
export function boardFeeds(): FeedStore {
	globalThis.klhFeeds ??= new FeedStore().share();
	return globalThis.klhFeeds;
}

export class KlhBoardMediator extends LitElement {
	static styles = css`
		:host {
			display: contents;
		}
	`;

	private store = boardFeeds();
	private unsubs: (() => void)[] = [];
	private ticker: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		for (const [name, schema] of Object.entries(FEED_SCHEMAS))
			this.store.validate(name, feedValidator(schema));
		this.addEventListener(FeedRefreshRequestedEvent.eventName, (e) => {
			e.stopPropagation();
			this.store.kick(e.feed, true);
		});
	}

	connectedCallback(): void {
		super.connectedCallback();
		const push = () => this.pushConn();
		this.unsubs = ["data", "dec"].map((n) => this.store.subscribe(n, push));
		// ages tick at 1Hz without a fetch; paused with the page
		this.ticker = setInterval(() => {
			if (!document.hidden) push();
		}, 1000);
		push();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const u of this.unsubs) u();
		this.unsubs = [];
		if (this.ticker !== null) clearInterval(this.ticker);
		this.ticker = null;
	}

	/** Data down: the conn verdict, computed from the two feed states. */
	private pushConn(): void {
		const data = this.store.get("data");
		const dec = this.store.get("dec");
		const banners = this.querySelectorAll<KlhConnBanner>("klh-conn-banner");
		if (!banners.length) return;
		const obs = (data?.data as { observation?: Observation } | null)
			?.observation;
		const verdict = connVerdict(
			{
				observation: obs,
				dataOkAt: data?.okAt ?? 0,
				dataErr: errOf(data),
				decOkAt: dec?.okAt ?? 0,
				decErr: errOf(dec),
				decLoaded: dec?.loaded ?? false,
				now: Date.now(),
			},
			ago,
			(ms) => embedDualStamp(ms ?? Number.NaN),
		);
		for (const b of banners) b.verdict = verdict;
	}

	protected render() {
		return html`<slot></slot>`;
	}
}

const errOf = (st: FeedState | null) => (st ? st.err : null);

if (!customElements.get("klh-board-mediator"))
	customElements.define("klh-board-mediator", KlhBoardMediator);
