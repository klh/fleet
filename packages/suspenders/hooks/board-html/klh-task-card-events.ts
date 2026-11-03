// hooks/board-html/klh-task-card-events.ts — the task-card leaf's event
// vocabulary (engineering standard: events up, data down; typed Event
// subclasses with readonly fields, never CustomEvent.detail). The card
// NEVER writes API state itself: every footer control dispatches one of
// these; the mediator (W2267.4.2 wiring) decides and stops propagation.
import { BoardEvent } from "./board-events.ts";
import type { TaskCardActionKind } from "./klh-task-card-model.ts";

/** A footer action was invoked — retry/recover/prompt/start/reassign/
 * release. `action`, `id` and `project` identify the target; the pick
 * fields carry the selects' live values at click time. */
export class TaskCardActionRequestedEvent extends BoardEvent {
	static readonly eventName = "task-card-action-requested" as const;
	readonly action: TaskCardActionKind;
	readonly id: string;
	readonly project: string | null;
	readonly executor?: string;
	readonly effort?: string;
	constructor(
		action: TaskCardActionKind,
		id: string,
		project: string | null,
		pick?: { executor?: string; effort?: string },
	) {
		super(TaskCardActionRequestedEvent.eventName);
		this.action = action;
		this.id = id;
		this.project = project;
		this.executor = pick?.executor;
		this.effort = pick?.effort;
	}
}

/** The id/title/age band was activated (click or Enter/Space on the ID
 * button) — the mediator opens the task drawer. */
export class TaskCardOpenRequestedEvent extends BoardEvent {
	static readonly eventName = "task-card-open-requested" as const;
	readonly id: string;
	readonly project: string | null;
	constructor(id: string, project: string | null) {
		super(TaskCardOpenRequestedEvent.eventName);
		this.id = id;
		this.project = project;
	}
}

declare global {
	interface HTMLElementEventMap {
		"task-card-action-requested": TaskCardActionRequestedEvent;
		"task-card-open-requested": TaskCardOpenRequestedEvent;
	}
}
