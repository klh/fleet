// fleet-loop/events.ts — the loop's one coord-bus event emitter: a single
// insert into the governor events table for every lane.* / plane.* event
// the tick raises (stall-watch, rogue sweep). Failures are swallowed —
// events are advisory, the tick must survive.
import { openStore } from "../govdb.ts";
import type { GovernorStore } from "../govdb.ts";

export function emitLoopEvent(
	kind: string,
	item: string,
	payload: object,
	store: GovernorStore = openStore(),
): void {
	try {
		store
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', ?, ?, ?, NULL)",
			)
			.run(Date.now(), kind, item, JSON.stringify(payload));
	} catch {}
}
