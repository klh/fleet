// hooks/board-html/setup-events.ts — the setup family's typed event
// vocabulary (engineering standard: events up, data down). Every event
// bubbles and is composed so it crosses shadow roots up to
// <klh-setup-mediator>, which handles it and stops propagation. Payloads
// ride readonly fields, never `detail`. Naming follows board-events.ts:
// `<noun>-<verb>-requested` for asks the mediator decides.

import { BoardEvent } from "./board-events.ts";

/** A check card asks the mediator to copy its `fix` command to the
 * clipboard (success/failure toasts ride the mediator — the old chunk's
 * copyfix button contract). */
export class SetupFixCopyRequestedEvent extends BoardEvent {
	static readonly eventName = "setup-fix-copy-requested" as const;
	readonly fix: string;
	constructor(fix: string) {
		super(SetupFixCopyRequestedEvent.eventName);
		this.fix = fix;
	}
}

declare global {
	interface HTMLElementEventMap {
		"setup-fix-copy-requested": SetupFixCopyRequestedEvent;
	}
}
