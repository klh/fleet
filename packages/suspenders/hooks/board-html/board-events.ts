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

/** A local (non-feed) error banner asks its owner to clear it. */
export class ErrorDismissRequestedEvent extends BoardEvent {
	static readonly eventName = "error-dismiss-requested" as const;
	readonly source: string;
	constructor(source: string) {
		super(ErrorDismissRequestedEvent.eventName);
		this.source = source;
	}
}

declare global {
	interface HTMLElementEventMap {
		"error-dismiss-requested": ErrorDismissRequestedEvent;
		"feed-refresh-requested": FeedRefreshRequestedEvent;
	}
}
