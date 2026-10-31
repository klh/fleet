// klh-event.base.ts — W2269.1.1: the ONE event base for fleet UI. bubbles +
// composed default true so events cross shadow roots; payloads are typed
// readonly fields on the subclass, never CustomEvent.detail.
export class KlhEvent extends Event {
	constructor(type: string, init: EventInit = {}) {
		super(type, { bubbles: true, composed: true, ...init });
	}
}
