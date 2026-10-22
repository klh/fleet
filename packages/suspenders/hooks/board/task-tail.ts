import type { GovernorStore } from "../lib/govdb.ts";
import { newerLane, readLaneRegistry } from "../lib/lane-registry.ts";
import { transcriptTailAll } from "./lanes.ts";

interface TaskClaim {
	project: string;
	id: string;
	owner_sid: string | null;
}
type Attempt = {
	sid: string;
	item: string;
	attempt?: number;
	launchedAt?: number;
};

/** A session inbox is not a task progress feed. Only an exact dispatch
 * binding authorizes transcript observations, dated within that attempt. */
export function taskTailSnapshot(
	db: GovernorStore,
	claims: readonly TaskClaim[],
) {
	const projects = new Map(
		(
			db.query("SELECT sid, project FROM sessions").all() as {
				sid: string;
				project: string | null;
			}[]
		).map((s) => [s.sid, s.project]),
	);
	const attempts = new Map<string, Attempt>();
	for (const project of new Set(claims.map((w) => w.project))) {
		try {
			const read = readLaneRegistry<Attempt>(project);
			if (!read.known) continue;
			for (const row of read.lanes) {
				const key = `${project}\0${row.item}\0${row.sid}`;
				const previous = attempts.get(key);
				attempts.set(key, previous ? newerLane(previous, row) : row);
			}
		} catch {
			/* No authoritative local binding: no task-specific tail. */
		}
	}
	return (claim: TaskClaim, maxChars = 110, max = 1) => {
		const row = attempts.get(
			`${claim.project}\0${claim.id}\0${claim.owner_sid}`,
		);
		if (
			!row ||
			!Number.isFinite(row.launchedAt) ||
			(row.launchedAt ?? 0) <= 0 ||
			projects.get(row.sid) !== claim.project
		)
			return [];
		return transcriptTailAll(row.sid, max, maxChars, row.launchedAt);
	};
}
