// hooks/lib/lanes/session-contract.ts — hub-of-one phase 6: ONE supervisor.
// The fleet-loop controller lease holder is the only supervisor of a project;
// every other interactive session is a worker. SessionStart and the push
// gate ask `isControllerSession` before rendering the SUPERVISOR DEFAULT /
// CONTRACT faces; everyone else receives the worker contract. Manual
// `dispatch` stays allowed — the contract says so — it is an owner-asked
// lane, not a refill loop.
import {
	controllerHolderLiveness,
	observeControllerLease,
} from "../../../scripts/lib/controller-fence.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import { gateClientPid, ppid } from "./fleetlane.ts";

// a session is the supervisor when the live controller lease holder is one
// of its process ancestors (the controller launched it). Unknown or absent
// controller = worker: authority is never inferred.
// SUSPENDERS_SESSION_CONTRACT=supervisor restores the pre-phase-6 shape.
export function isControllerSession(
	store: GovernorStore,
	project: string,
	pid = gateClientPid(),
): boolean {
	if (process.env.SUSPENDERS_SESSION_CONTRACT === "supervisor") return true;
	try {
		const lease = observeControllerLease(store, project);
		if (!lease || controllerHolderLiveness(lease) !== "alive") return false;
		for (let p = pid, hops = 0; p > 1 && hops < 32; p = ppid(p), hops++)
			if (p === lease.pid) return true;
	} catch {
		// store or ps miss: no authority
	}
	return false;
}

export function workerContract(ready: number, status: string): string {
	return `WORKER CONTRACT: ${status} This interactive session is a worker, not a supervisor — the fleet-loop controller lease holder is the only supervisor and owns refill, dispatch capacity and automatic recovery. Continue owned items first; take READY work (${ready} now) with work take before code work. Never arm a refill cron or /loop, never run a global prune/reclaim sweep. Manual dispatch stays allowed when the owner asks for a specific lane. Deliver owner corrections to a live lane with coord message <sid>; report with work report.`;
}
