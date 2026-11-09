// hooks/board-html/report-events.ts — the report family's typed event
// vocabulary (engineering standard: events up, data down). Every event
// bubbles and is composed so it crosses shadow roots up to
// <klh-report-mediator>, which handles it and stops propagation. Payloads
// ride readonly fields, never `detail`. Naming follows board-events.ts:
// `<noun>-<verb>-requested` for asks the mediator decides.

import { BoardEvent } from "./board-events.ts";

/** The pane asks the mediator to expand (or close) the row detail `id`.
 * Toggling the open row closes it — the old chunk's chip contract. */
export class ReportRowToggleRequestedEvent extends BoardEvent {
	static readonly eventName = "report-row-toggle-requested" as const;
	readonly id: string;
	constructor(id: string) {
		super(ReportRowToggleRequestedEvent.eventName);
		this.id = id;
	}
}

declare global {
	interface HTMLElementEventMap {
		"report-row-toggle-requested": ReportRowToggleRequestedEvent;
	}
}
