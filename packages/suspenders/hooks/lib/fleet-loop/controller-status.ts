// hooks/lib/fleet-loop/controller-status.ts — fork E: per-project controller
// status, the same facts the supervisor CONTROL SNAPSHOT reads (lease holder
// liveness + dispatch/reclaim/merge holds) plus the last cycle (the lease's
// renewed_at — the controller renews it at every acting boundary). Read-only
// observation for `work report --all` and the board: a snapshot, never
// authorization.
import { join } from "node:path";
import {
	type ControllerLease,
	controllerHolderLiveness,
} from "../../../scripts/lib/controller-fence.ts";
import { dispatchHeld } from "../../../scripts/lib/refill-window.ts";
import { projectRootOf } from "../govdb/govdb.ts";
import { automaticRecoveryPaused } from "./automatic-recovery.ts";
import { mergeHoldActive } from "./merge-hold.ts";

export interface ControllerStatus {
	project: string;
	/** lease holder liveness; "absent" = no controller holds this project */
	state: "alive" | "dead" | "unknown" | "absent";
	pid: number | null;
	host: string | null;
	/** ms since the holder's last acting boundary (null = no lease) */
	last_cycle_ms_ago: number | null;
	/** active operator holds: dispatch | reclaim | merge ("unknown" on error) */
	holds: string[];
}

/** Any reader with a prepared-statement face — the governor store or a raw
 *  bun:sqlite handle (work report). Read-only: a missing lease table reads
 *  as "no controller", never a schema write from an observer. */
export interface LeaseReader {
	query(sql: string): { get(...params: unknown[]): unknown };
}

const leaseOf = (db: LeaseReader, project: string): ControllerLease | null => {
	try {
		return (
			(db
				.query("SELECT * FROM controller_leases WHERE project=?")
				.get(project) as ControllerLease | null) ?? null
		);
	} catch {
		return null;
	}
};

export function controllerStatus(
	db: LeaseReader,
	project: string,
	now: number = Date.now(),
): ControllerStatus {
	const lease = leaseOf(db, project);
	const holds: string[] = [];
	try {
		const root = projectRootOf(project);
		if (dispatchHeld(join(root, ".fleet"))) holds.push("dispatch");
		if (automaticRecoveryPaused(root)) holds.push("reclaim");
		if (mergeHoldActive(root)) holds.push("merge");
	} catch {
		holds.push("unknown");
	}
	return {
		project,
		state: lease ? controllerHolderLiveness(lease) : "absent",
		pid: lease?.pid ?? null,
		host: lease?.host ?? null,
		last_cycle_ms_ago: lease ? Math.max(0, now - lease.renewed_at) : null,
		holds,
	};
}

/** One line per project for text views: `fleet ◐ pid 123 · 40s ago · held: dispatch`. */
export function controllerStatusLine(s: ControllerStatus): string {
	const name = projectRootOf(s.project).split("/").pop() || s.project;
	const bits = [`${name} controller ${s.state}`];
	if (s.pid !== null) bits.push(`pid ${s.pid}`);
	if (s.last_cycle_ms_ago !== null)
		bits.push(`last cycle ${Math.round(s.last_cycle_ms_ago / 1000)}s ago`);
	if (s.holds.length > 0) bits.push(`held: ${s.holds.join("/")}`);
	return bits.join(" · ");
}
