// hooks/lib/fleet-loop/multi-project.ts — fork E (hub-of-one): one hub
// controller supervises EVERY registered repo. Each watch boundary:
//   1. resolve primary (--repo) + registry rows → supervised projects;
//   2. per project: the W576.5 controller boundary on that project's lease
//      (semantics unchanged per project: standby while a live holder keeps
//      it, takeover only a provably dead one, handoff at the idle boundary);
//   3. measure live claims + READY per acting project and deal the global
//      lane ceiling round-robin (lane-allocation.ts);
//   4. run one killable `once` child per acting project — per-project merge
//      ladder, dispatch, stall watch, reclaim. Hub-wide sweeps (runtime sync,
//      wisdom, rogue, maintenance) ride ONLY the primary's child
//      (--project-only on the rest): maintenance stays single-instance.
import { join } from "node:path";
import {
	controllerWatchBoundary,
	releaseControllerLeasesExcept,
} from "../../../scripts/lib/controller-fence.ts";
import { dispatchHeld } from "../../../scripts/lib/refill-window.ts";
import { type GovernorStore, projectRootOf } from "../govdb/govdb.ts";
import { allocateLaneTargets, type LaneDemand } from "./lane-allocation.ts";
import type { SupervisedProject } from "./project-registry.ts";

type Identity = Parameters<typeof controllerWatchBoundary>[2];

export interface BoundaryResult {
	acting: SupervisedProject[];
	standby: SupervisedProject[];
	/** a project's owner-requested handoff fired: every lease was released */
	handoff: SupervisedProject | null;
	/** leases dropped for repos that left the registry */
	dropped: string[];
}

/** Step 2 for every project, in one pass. A handoff on ANY project releases
 *  ALL of this controller's leases (one process = one generation — the
 *  KeepAlive successor assumes every project together). */
export function projectsBoundary(
	store: GovernorStore,
	projects: SupervisedProject[],
	identity: Identity,
): BoundaryResult {
	const dropped = releaseControllerLeasesExcept(
		store,
		identity.nonce,
		projects.map((p) => p.key),
	);
	const acting: SupervisedProject[] = [];
	const standby: SupervisedProject[] = [];
	for (const p of projects) {
		const verdict = controllerWatchBoundary(store, p.key, identity);
		if (verdict === "handoff") {
			releaseControllerLeasesExcept(store, identity.nonce, []);
			return { acting: [], standby: [], handoff: p, dropped };
		}
		(verdict === "acting" ? acting : standby).push(p);
	}
	return { acting, standby, handoff: null, dropped };
}

/** Live lanes (CLAIMED/RUNNING items) and READY depth per project key. */
export function projectDemand(
	store: GovernorStore,
	projects: SupervisedProject[],
): LaneDemand[] {
	const rows = store
		.query(
			"SELECT project, state, COUNT(*) AS n FROM work_items WHERE state IN ('READY','CLAIMED','RUNNING') GROUP BY project, state",
		)
		.all() as { project: string; state: string; n: number }[];
	return projects.map((p) => {
		let live = 0;
		let ready = 0;
		for (const r of rows) {
			if (r.project !== p.key) continue;
			if (r.state === "READY") ready += r.n;
			else live += r.n;
		}
		return { key: p.key, live, ready, cap: p.cap };
	});
}

/** Step 3: each acting project's dispatch target this cycle. A project
 *  under an operator dispatch hold still gets a target (dispatch itself
 *  honors the hold) but never consumes free slots another repo could use. */
export function projectTargets(
	store: GovernorStore,
	acting: SupervisedProject[],
	globalCap: number,
	rotation: number,
	held: (p: SupervisedProject) => boolean = (p) =>
		dispatchHeld(join(projectRootOf(p.key), ".fleet")),
): Map<string, number> {
	const demands = projectDemand(store, acting).map((d) => {
		const p = acting.find((a) => a.key === d.key);
		return p && held(p) ? { ...d, ready: 0 } : d;
	});
	return allocateLaneTargets(demands, globalCap, rotation).targets;
}

/** flags a registered project's child inherits from the controller argv */
const PASSTHROUGH = [
	"--agent",
	"--effort",
	"--ladder-timeout",
	"--stall-warn-min",
] as const;

/** Step 4 argv for one project's `once` child. The primary keeps the
 *  controller's own argv verbatim (back-compat: its --log, --ladder, … all
 *  ride through) with --repo pinned to the caller dir; registered repos get
 *  a fresh argv from their registry row + the passthrough flags. */
export function projectChildArgs(
	p: SupervisedProject,
	controllerArgv: string[],
	callerRepo: string,
	laneTarget: number | undefined,
): string[] {
	const tail =
		laneTarget === undefined ? [] : ["--lane-target", `${laneTarget}`];
	if (p.primary) {
		const args = controllerArgv.slice(1);
		const at = args.indexOf("--repo");
		if (at >= 0) args[at + 1] = callerRepo;
		return ["once", ...args, ...tail];
	}
	const args = ["once", "--repo", p.repo, "--glob", p.glob, "--main", p.main];
	if (p.ladder) args.push("--ladder", p.ladder);
	if (p.dispatch) args.push("--dispatch-cmd", p.dispatch);
	for (const f of PASSTHROUGH) {
		const at = controllerArgv.indexOf(f);
		const v = at >= 0 ? controllerArgv[at + 1] : undefined;
		if (v !== undefined) args.push(f, v);
	}
	return [...args, "--project-only", ...tail];
}
