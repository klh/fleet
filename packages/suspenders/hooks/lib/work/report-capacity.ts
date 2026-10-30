// hooks/lib/work/report-capacity.ts — W2314 Kueue saturation counters
// (docs/design/w2312-kueue-adoption.md pattern 2): work report + board
// render pending (READY pool) / held (non-terminal launch intents not
// covered by a live lane) / admitted (live lanes) SEPARATELY against the
// ONE steady target, so the operator sees saturation, not just occupancy.
// heldLaunchItems stays the held definition (the same fence the dispatcher
// charges capacity against — dispatch-next.ts:505); laneAlive stays the
// ONLY liveness oracle. A separate held-cap is deliberately NOT here
// (later config-over-code refinement).

import type { Database } from "bun:sqlite";
import { fleetLoopSettings } from "../stack-config.ts";
import { heldLaunchItems } from "../../../scripts/lib/launch-fencing.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { laneAlive, type LaneRef } from "../lanes/lane-liveness.ts";
import type { RegistryLane } from "../lanes/lane-registry.ts";

/** One saturation row — the Kueue triple against the steady target.
 *  target null = no numeric ceiling (Plaid posture); saturation unknown. */
export interface ReportCapacity {
	/** pending: READY work_items — the local queue depth */
	pending: number;
	/** held: non-terminal launch intents with NO live lane on the item —
	 *  reserved-but-not-admitted capacity (Kueue QuotaReserved analog) */
	held: number;
	/** admitted: live lanes (registry rows the shared verdict calls live) */
	admitted: number;
	/** steady dispatch target (fleet_loop.dispatch_target, default 8) */
	target: number | null;
}

/** Fail-soft SELECT COUNT — a schema without work_items answers 0. */
const countReady = (db: Database, project: string): number => {
	try {
		return (
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
					)
					.get(project) as { n: number } | null
			)?.n ?? 0
		);
	} catch {
		return 0;
	}
};

/** The saturation triple. held counts only intents whose item has NO live
 *  lane (dispatch-next's heldSlots shape — a live lane's intent is admitted,
 *  not held). Fail-soft on the intents table: no table = 0 held, never a
 *  dead report. */
export const reportCapacity = (
	db: Database,
	project: string,
	registry: readonly RegistryLane[],
	liveProbe: (l: LaneRef) => boolean = laneAlive,
	/** pin: the intents store binding (tests inject a scratch store); the
	 *  default opens the ONE store like every dispatch-side reader */
	store?: GovernorStore,
): ReportCapacity => {
	const pending = countReady(db, project);
	const live = registry.filter((l) => liveProbe(l as LaneRef));
	const liveItems = new Set(live.map((l) => l.item ?? ""));
	let held = 0;
	try {
		const intents = heldLaunchItems((store ?? db) as GovernorStore, project);
		held = [...intents].filter((item) => !liveItems.has(item)).length;
	} catch {
		// no lane_launch_intents table (fresh graph) — nothing is held
	}
	return {
		pending,
		held,
		admitted: live.length,
		target: fleetLoopSettings().dispatchTarget,
	};
};

/** Saturation line for the report footer + the board pane — the ONE
 *  render, both faces consume it (`4/8 · held 1 · pending 27`). */
export const capacityLine = (c: ReportCapacity): string =>
	c.target == null
		? `live ${c.admitted} · held ${c.held} · pending ${c.pending}`
		: `${c.admitted + c.held}/${c.target} · held ${c.held} · pending ${c.pending}`;
