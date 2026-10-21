// reclaim-all.ts — W376: one source of truth for the `work reclaim all` bulk
// pass. The verb (hooks/bin/work.ts) renders the result for the operator; the
// fleet-loop reclaim sweep (hooks/lib/fleet-loop/reclaim-sweep.ts) runs the
// same core per cycle and broadcasts releases. The pass reclaims every
// CLAIMED/RUNNING claim whose claimant is verifiably dead — W610 liveness
// parity: registry process identity + claimant transcript + governor
// heartbeat, death repeated STRIKES_TO_RECLAIM consecutive passes
// (fact-counted), `work extend` leases honored, unknown NEVER releases
// (monitor doctrine W51: lookup failure is never death).
import type { GovernorStore } from "./govdb.ts";
import { loadLaneRegistry } from "./lane-registry.ts";
import type { LaneRef } from "./lane-liveness.ts";
import { clearReclaimStrikes, observeReclaim } from "./reclaim-liveness.ts";
import { releaseWorkClaim } from "./work-release.ts";

// registry rows the claim-liveness verdict joins on (work.ts claimantLanes
// parity): a claimant with no entry (manual takes, reaped rows) probes from
// heartbeat + transcript alone and reads unknown, never dead.
type RegistryRow = {
	sid: string;
	item: string;
	pid?: number;
	worktree?: string;
	host?: string;
	launchedAt?: number;
};

export type ReclaimAllRow =
	| { id: string; action: "released"; was: string; why: string }
	| { id: string; action: "held"; why: string }
	| { id: string; action: "changed"; why: string };

/** One bulk reclaim pass over a project's CLAIMED/RUNNING claims, in item
 * order. `changed` rows are claims that moved between observation and
 * release — the CAS refused, audit only. */
export function reclaimAll(
	store: GovernorStore,
	project: string,
	registryDir: string,
): ReclaimAllRow[] {
	const claimants = lanesBySid(registryDir);
	const rows = store
		.query(
			"SELECT * FROM work_items WHERE project = ? AND state IN ('CLAIMED','RUNNING') ORDER BY id",
		)
		.all(project) as Record<string, string | number | null>[];
	const out: ReclaimAllRow[] = [];
	for (const r of rows) {
		const id = String(r.id);
		const owner = String(r.owner_sid ?? "");
		const lane = matchingClaimantLane(claimants, owner, id);
		const d = observeReclaim(store, project, {
			id,
			owner,
			revision: Number(r.updated_at),
			lane,
		});
		if (d.action !== "release") {
			out.push({ id, action: "held", why: d.why });
			continue;
		}
		const released = releaseWorkClaim(
			store,
			{
				project,
				id,
				owner: owner || null,
				state: String(r.state),
				updatedAt: Number(r.updated_at),
			},
			{ by: "reclaim-all", reason: "reclaim-all" },
		);
		if (!released) {
			out.push({ id, action: "changed", why: "claim changed — skipped" });
			continue;
		}
		clearReclaimStrikes(store, project, id);
		out.push({ id, action: "released", was: owner.slice(0, 8), why: d.why });
	}
	return out;
}

const lanesBySid = (registryDir: string): Map<string, LaneRef> =>
	new Map(
		loadLaneRegistry<RegistryRow>(registryDir).map((l) => [
			l.sid,
			{
				sid: l.sid,
				item: l.item,
				pid: l.pid,
				worktree: l.worktree,
				host: l.host,
				launchedAt: l.launchedAt,
			},
		]),
	);

/** Claimant LaneRefs by sid — the registry view the claim-liveness verdict
 * joins on (shared by the orphaned listing and the bulk pass). */
export const claimantLanes = lanesBySid;

/** A session may own several work items; only the matching registry row is
 * process evidence for this particular claim. */
export const matchingClaimantLane = (
	lanes: Map<string, LaneRef>,
	owner: string,
	id: string,
): LaneRef | undefined => {
	const lane = lanes.get(owner);
	return lane?.item === id ? lane : undefined;
};
