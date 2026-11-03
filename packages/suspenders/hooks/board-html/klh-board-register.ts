// hooks/board-html/klh-board-register.ts — W2267.4.2.2: the ONE workspace
// registration entry for the board's Lit bridge components (root pointer
// #103173): class modules export definitions only, this entry composes
// them through @klh/design-ui's defineElement (duplicate registration
// fails loud across host/card/activity bundles), and the canonical vendor
// build loads exactly this entry — never a component module directly.
import { defineElement } from "@klh/design-ui";
import { KlhTaskCardHost } from "./klh-task-card-host.ts";
import { KlhTaskCard } from "./klh-task-card.ts";
import { KlhCardActivity } from "./klh-card-activity.ts";

export const registerBoardElements = (): void => {
	defineElement("klh-task-card-host", KlhTaskCardHost);
	defineElement("klh-task-card", KlhTaskCard);
	defineElement("klh-card-activity", KlhCardActivity);
};

registerBoardElements();
