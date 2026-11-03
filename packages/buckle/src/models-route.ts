// src/models-route.ts — W1265.2: the account-bound /v1/models face. Every
// route arm (named base, /w/<lane> prefix, legacy bare) resolves the
// account-discovery verdict before listing: anonymous/unknown keys refuse
// (typed 403, zero outbound), lane slugs bind, root rides, and the listing
// filters to the class's entitled groups (null = unfiltered).
// W2635: rows carry the deployment's admission numbers when it rides an
// explicit provider pool — the pool id is operator config
// (adapter_config.provider_pool), the live counters come from the router's
// admission snapshots, and a model spanning deployments reports each pool
// once (numbers describe the POOL, not the row).
import {
	discoveryFilter,
	globMatch,
	REPO_CLAIM_HEADER,
} from "./account-policy.ts";
import { problem } from "./citizenship.ts";
import type { AppDeps } from "./handlers.ts";
import type { IngressLocal } from "./ingress-routes.ts";
import { principalOf } from "./gov/federation.ts";
import { providerPoolIdOf } from "./router-attempt.ts";

/** W2635: pool caps + live counters one model row carries (numbers describe
 *  the POOL, not the row — all member deployments share one admission). */
export interface PoolNumbers {
	provider_pool: string;
	concurrency: number;
	concurrency_ceiling: number;
	outstanding: number;
	queued: number;
	active: number;
	max_outstanding: number;
	rate_per_interval: number;
	interval_ms: number;
}

/** W2635: the admission numbers one model row reports — present only when
 *  every bound deployment rides the SAME explicit provider pool (a model
 *  split across pools or pool-less has no single honest number; null keeps
 *  the listing a pure catalog). */
export function poolNumbersOf(
	deps: AppDeps,
	group: string,
): PoolNumbers | null {
	const ids = new Set(
		deps.pool
			.deployments(group)
			.map((dep) => providerPoolIdOf(dep))
			.filter((id): id is string => id !== null),
	);
	if (ids.size !== 1) return null;
	const id = [...ids][0] as string;
	const snap = deps.router.providerAdmissionSnapshot()[id];
	if (!snap) return null;
	const policy = deps.router.policy.provider_pools?.[id];
	if (!policy) return null;
	return {
		provider_pool: id,
		concurrency: snap.adaptiveConcurrency,
		concurrency_ceiling: snap.concurrencyCeiling,
		outstanding: snap.outstanding,
		queued: snap.queued,
		active: snap.active,
		max_outstanding: policy.maxOutstanding,
		rate_per_interval: policy.intervalCap,
		interval_ms: policy.intervalMs,
	};
}

export function modelsRoute(
	deps: AppDeps,
	req: Request,
	lane: string | null,
): Response {
	const principal = principalOf(req);
	const verdict = discoveryFilter(deps.accountPolicy ?? null, {
		kind: principal?.kind ?? null,
		keyName: principal?.name ?? null,
		claimRepo: req.headers.get(REPO_CLAIM_HEADER),
		lane,
	});
	if (!verdict.ok)
		return problem({
			status: verdict.status,
			code: verdict.code,
			why: verdict.why,
		});
	const groups = verdict.groups;
	const data = deps.pool
		.groups()
		.filter((id) => deps.pool.deployments(id).length > 0)
		.filter((id) => groups === null || groups.some((g) => globMatch(g, id)))
		.map((id) => {
			const pool = poolNumbersOf(deps, id);
			return {
				id,
				object: "model",
				owned_by: "buckle",
				...(pool === null ? {} : { admission: pool }),
			};
		});
	return Response.json({ object: "list", data });
}

export const modelsFace: IngressLocal = (req, lane, d) =>
	modelsRoute(d, req, lane);
