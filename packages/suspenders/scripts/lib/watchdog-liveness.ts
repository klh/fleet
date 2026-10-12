import {
	readLaneRegistry,
	type RegistryRead,
} from "../../hooks/lib/lane-registry.ts";
import {
	laneProcessIdentity,
	type LaneRef,
} from "../../hooks/lib/lane-liveness.ts";
import {
	fleetProgress,
	type WorkStats,
	type ProgressState,
} from "./fleet-progress.ts";

export type LaneAudit = { sid: string; live: boolean | null };
/** Temporary observation bridge until the shared CLI preserves process UNKNOWN. */
export function watchdogLiveness(
	project: string,
	audit: LaneAudit[],
	deps: {
		registry: (project: string) => RegistryRead<LaneRef>;
		identity: (lane: LaneRef) => boolean | null;
	} = { registry: readLaneRegistry<LaneRef>, identity: laneProcessIdentity },
): { live: number; unknown: number } {
	if (
		!Array.isArray(audit) ||
		audit.some(
			(lane) =>
				!lane ||
				typeof lane.sid !== "string" ||
				(typeof lane.live !== "boolean" && lane.live !== null),
		)
	)
		throw new Error("structured lane audit unavailable");
	const registry = deps.registry(project);
	if (!registry.known) throw new Error("canonical lane registry unavailable");
	const rows = new Map(registry.lanes.map((lane) => [lane.sid, lane]));
	let live = 0,
		unknown = 0;
	for (const lane of audit) {
		if (lane.live === true) {
			live++;
			continue;
		}
		const row = rows.get(lane.sid);
		const identity = row ? deps.identity(row) : null;
		if (identity === true) live++;
		else if (lane.live === null || identity === null) unknown++;
	}
	// A registry change during observation is incomplete evidence, never zero live proof.
	const observed = new Set(audit.map((lane) => lane.sid));
	for (const row of registry.lanes) if (!observed.has(row.sid)) unknown++;
	return { live, unknown };
}
export function watchdogProgress(
	stats: WorkStats,
	liveness: { live: number; unknown: number },
	previous: ProgressState,
	now: number,
) {
	const flow = fleetProgress(stats, liveness.live, previous, now);
	return {
		...flow,
		unknown: liveness.unknown,
		stalled: liveness.unknown === 0 && flow.stalled,
		restart: false,
		verdict:
			liveness.unknown > 0
				? ("unknown" as const)
				: flow.stalled
					? ("stalled" as const)
					: ("ok" as const),
	};
}
