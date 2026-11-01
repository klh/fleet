// klh-theme.events.ts — W2269.1.1: theme domain events, the seed domain for
// the typed event kit. Naming: <noun>-<verb>-requested (the mediator decides)
// or <noun>-<past tense> (this happened). Payloads are typed readonly fields
// — never CustomEvent.detail.
import { KlhEvent } from "./klh-event.base.ts";

export class ThemeChangeRequested extends KlhEvent {
	static readonly type = "theme-change-requested";
	constructor(
		readonly theme: "dark" | "light" | "high-contrast",
		init: EventInit = {},
	) {
		super(ThemeChangeRequested.type, init);
	}
}

export class ThemeChanged extends KlhEvent {
	static readonly type = "theme-changed";
	constructor(
		readonly theme: "dark" | "light" | "high-contrast",
		readonly origin: "gear" | "sync" | "system",
		init: EventInit = {},
	) {
		super(ThemeChanged.type, init);
	}
}

declare global {
	interface HTMLElementEventMap {
		"theme-change-requested": ThemeChangeRequested;
		"theme-changed": ThemeChanged;
	}
}
