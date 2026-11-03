// hooks/board-html/decisions-events.ts — the decisions family's typed event
// vocabulary (engineering standard: events up, data down). Every event
// bubbles and is composed so it crosses shadow roots up to
// <klh-decisions-mediator>, which handles it and stops propagation. Payloads
// ride readonly fields, never `detail`. Naming follows board-events.ts:
// `<noun>-<verb>-requested` for asks the mediator decides.

import { BoardEvent } from "./board-events.ts";

/** A card asks the mediator to submit an answer for decision `id`. */
export class DecisionAnswerRequestedEvent extends BoardEvent {
	static readonly eventName = "decision-answer-requested" as const;
	readonly id: string;
	readonly note: string;
	constructor(id: string, note: string) {
		super(DecisionAnswerRequestedEvent.eventName);
		this.id = id;
		this.note = note;
	}
}

/** A card asks the mediator to start (or retry) an advice request. */
export class DecisionAdviseRequestedEvent extends BoardEvent {
	static readonly eventName = "decision-advise-requested" as const;
	readonly id: string;
	constructor(id: string) {
		super(DecisionAdviseRequestedEvent.eventName);
		this.id = id;
	}
}

/** A card asks the mediator to cancel/dismiss decision `id` (confirm first). */
export class DecisionCancelRequestedEvent extends BoardEvent {
	static readonly eventName = "decision-cancel-requested" as const;
	readonly id: string;
	constructor(id: string) {
		super(DecisionCancelRequestedEvent.eventName);
		this.id = id;
	}
}

declare global {
	interface HTMLElementEventMap {
		"decision-answer-requested": DecisionAnswerRequestedEvent;
		"decision-advise-requested": DecisionAdviseRequestedEvent;
		"decision-cancel-requested": DecisionCancelRequestedEvent;
	}
}
