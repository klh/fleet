// hooks/board-html/board-events.ts — the board's typed event vocabulary
// (engineering standard: events up, data down). Every event bubbles and is
// composed so it crosses shadow roots up to <klh-board-mediator>, which
// handles it and stops propagation. Payloads ride readonly fields, never
// `detail`. Naming: `<noun>-<verb>-requested` for asks, `<noun>-<past>` for
// facts.

export class BoardEvent extends Event {
	constructor(type: string) {
		super(type, { bubbles: true, composed: true });
	}
}

/** A leaf asks the mediator to refetch one feed now (e.g. a retry button). */
export class FeedRefreshRequestedEvent extends BoardEvent {
	static readonly eventName = "feed-refresh-requested" as const;
	readonly feed: string;
	constructor(feed: string) {
		super(FeedRefreshRequestedEvent.eventName);
		this.feed = feed;
	}
}

declare global {
	interface HTMLElementEventMap {
		"feed-refresh-requested": FeedRefreshRequestedEvent;
	}
}
