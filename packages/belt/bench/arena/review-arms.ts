// review-arms.ts — W1476 (b): the arena arms as lazy leg factories, resolved
// only for the arms a run or rescore actually executes — an idle rescore
// check never pings a port or loads the lane plugin. Arms A/B ping their
// local leg ports first; the lane arm needs REVIEW_LANE_URL +
// REVIEW_LANE_MODEL (the suspenders rescore runner passes the resolved
// review model pin and a minted scoped key) and loads the surface's
// lanePlugin.
import { ARM_A_PORT, REVIEW_LEGS } from "./review-core.ts";
import { armLane, laneLeg, loadLanePlugin } from "./review-lane-arm.ts";
import { armA, armB, pingLocal } from "./review-pipeline.ts";
import type { ArmExec, ArmLegFactory } from "./review-rescore-run.ts";
import type { ArmId } from "./review-score.ts";

const pinged =
	(ports: number[], exec: ArmExec): ArmLegFactory =>
	async () => {
		for (const p of new Set(ports)) {
			if (!(await pingLocal(p)))
				return `leg port ${p} not answering — re-point REVIEW_*_PORT or load the tier`;
		}
		return { exec };
	};

/** Every arm's leg factory over the repo at `root`. */
export function armLegs(o: {
	root: string;
	lanePlugin: string;
	env?: Record<string, string | undefined>;
}): Record<ArmId, ArmLegFactory> {
	return {
		a: pinged([ARM_A_PORT], (t) => armA(t)),
		b: pinged(
			Object.values(REVIEW_LEGS).map((l) => l.port),
			(t) => armB(t),
		),
		lane: async () => {
			const leg = laneLeg(o.env);
			if (!leg)
				return "no lane leg — set REVIEW_LANE_URL + REVIEW_LANE_MODEL (the suspenders review-rescore runner does)";
			const plugin = await loadLanePlugin(o.root, o.lanePlugin);
			return {
				exec: (t) => armLane(t, plugin, leg),
				model: leg.model,
				plugin: plugin.version,
			};
		},
	};
}
