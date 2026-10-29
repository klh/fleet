// hooks/lib/fleet-loop/pool-ramp-plan.ts — W2263: the staged raise plan
// for provider-pool concurrency. Configured ceilings are CEILINGS, not
// proven throughput (owner: never assume 8+8+8 = 24 productive slots) —
// production concurrency only rises after a stage's matched live load
// test passes and the negative-results log records why any stage was
// refused. Pure planning: no traffic, no probes — the operator-run
// capacity-ramp harness sends the actual load when the dispatch hold
// has lifted, with stages drawn from here.
import {
	type ProviderPools,
	automaticCeiling,
	poolOfModel,
} from "./provider-pools.ts";

/** Conservative stage ladder: fractions of the automatic ceiling. Stage
 *  0 is the floor the incident already survived (2026-10-29: ~15 lanes
 *  + interactive 429'd at configured concurrency 50 — proven capacity is
 *  BELOW every configured number). */
export const RAMP_STAGES = [0.25, 0.5, 0.75, 1] as const;

export type PoolRampStage = {
	poolKey: string;
	model: string;
	stage: number;
	lanes: number;
	ceiling: number;
};

export type PoolRampPlan = {
	stages: PoolRampStage[];
	notes: string[];
};

/** Build the staged plan over the CURRENT occupancy (a pool already at
 *  its ceiling contributes no raise stages — only hold verification). */
export function buildPoolRampPlan(o: {
	pools: ProviderPools;
	counts: Map<string, number>;
	now?: number;
}): PoolRampPlan {
	const notes: string[] = [
		"stage lanes are CONCURRENT AUTOMATIC LANES on the pool's reservation key (running+reserved, aliases collapsed)",
		"a stage passes only when its matched live load test holds: no provider 429, no review/interactive starvation, lanes stay productive",
		"never run during an active dispatch hold; record every refused/failed stage in docs/research/provider-pool-negative-results.md before raising",
	];
	const stages: PoolRampStage[] = [];
	for (const [id, pool] of Object.entries(o.pools)) {
		const ceiling = automaticCeiling(pool);
		const admitted = o.counts.get(pool.quota_pool_id ?? id) ?? 0;
		for (const frac of RAMP_STAGES) {
			const lanes = Math.max(1, Math.floor(ceiling * frac));
			if (lanes <= admitted) continue; // already proven at/above this stage
			stages.push({
				poolKey: pool.quota_pool_id ?? id,
				model: pool.models[0] ?? id,
				stage: frac,
				lanes,
				ceiling,
			});
		}
	}
	return { stages, notes };
}

/** The capacity-ramp route args for one stage (the operator harness's
 *  --route grammar: [name=]model@wire). */
export const stageRouteArg = (s: PoolRampStage): string =>
	`${s.poolKey}-s${String(Math.round(s.stage * 100))}=${s.model}@messages`;

/** Whether a pool's current occupancy already proves the pool holds at
 *  this stage without new load (negative-log evidence still required). */
export const stageProven = (
	pools: ProviderPools,
	counts: Map<string, number>,
	model: string,
): boolean => {
	const p = poolOfModel(pools, model);
	if (!p) return false;
	return (counts.get(p.key) ?? 0) > 0;
};
