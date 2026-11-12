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
import type { UpstreamPool } from "./upstreams.ts";
import type { ModelCapabilities } from "./wire-schemas.ts";

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
	// W2635.1: EVERY deployment must ride the same explicit pool — filtering
	// pool-less deployments out first let [poolA, no-pool] report poolA's
	// numbers, which describe only half the model's rides.
	const deployments = deps.pool.deployments(group);
	const id = deployments[0] ? providerPoolIdOf(deployments[0]) : null;
	if (id === null) return null;
	if (!deployments.every((dep) => providerPoolIdOf(dep) === id)) return null;
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

/** W2979: the conf-pinned serving capabilities one model row reports.
 *
 *  Publication rule (conservative truthful omission — C448):
 *  the router walk CROSSES fallback groups (GatewayPolicy.fallbacks), so a
 *  group's claim is only guaranteed when EVERY group reachable on the walk —
 *  itself, its transitive fallbacks, and every deployment inside each — pins
 *  capabilities and they all agree exactly. Any unreachable/missing/mismatched
 *  rung ⇒ the row advertises NOTHING: half-honest metadata (or an invented
 *  minimum across rungs) is worse than none. Values are operator conf,
 *  never computed here. */
export function capabilitiesOf(
	pool: UpstreamPool,
	group: string,
	fallbacks?: Record<string, string[]>,
): ModelCapabilities | null {
	// Walk the fallback chain: cycle-safe, bounded by the reachable set.
	const reachable = new Set<string>([group]);
	const queue = [group];
	while (queue.length > 0) {
		const g = queue.pop() as string;
		for (const fb of fallbacks?.[g] ?? []) {
			if (!reachable.has(fb)) {
				reachable.add(fb);
				queue.push(fb);
			}
		}
	}
	let first: string | undefined;
	let agreed: ModelCapabilities | undefined;
	for (const g of reachable) {
		const deployments = pool.deployments(g);
		// A reachable group with no deployments (dangling fallback name) can
		// still be walked onto at serve time — its limits are unknown ⇒ omit.
		if (deployments.length === 0) return null;
		for (const dep of deployments) {
			if (dep.capabilities === undefined) return null;
			const key = JSON.stringify(dep.capabilities);
			if (first === undefined) {
				first = key;
				agreed = dep.capabilities;
			} else if (key !== first) {
				return null;
			}
		}
	}
	return agreed ?? null;
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
		.filter((id) =>
			deps.pool.deployments(id).some((dep) => dep.discover !== false),
		)
		.filter((id) => groups === null || groups.some((g) => globMatch(g, id)))
		.map((id) => {
			const pool = poolNumbersOf(deps, id);
			const caps = capabilitiesOf(deps.pool, id, deps.router.policy.fallbacks);
			return {
				id,
				object: "model",
				owned_by: "buckle",
				...(pool === null ? {} : { admission: pool }),
				...(caps === null
					? {}
					: {
							...(caps.context_length !== undefined
								? { context_length: caps.context_length }
								: {}),
							...(caps.max_output_tokens !== undefined
								? { max_output_tokens: caps.max_output_tokens }
								: {}),
							...(caps.reasoning !== undefined
								? { reasoning: caps.reasoning }
								: {}),
							...(caps.capability_source !== undefined
								? { capability_source: caps.capability_source }
								: {}),
						}),
			};
		});
	return Response.json({ object: "list", data });
}

export const modelsFace: IngressLocal = (req, lane, d) =>
	modelsRoute(d, req, lane);
