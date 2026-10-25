// src/router.ts — W1299 decomposition: the Router shell. The walk lives in
// purpose modules — router-walk (ladder walks), router-groups (group
// resolution), router-attempt (single-attempt classification), router-receipt
// (hop receipts), router-types (contracts). This file owns construction,
// fail-closed pool-binding validation, and the execute() entrypoint; behavior
// is identical to the pre-split monolith (semantics ported from the
// MIT-licensed LiteLLM 1.103.0 core, pinned-source verified W129).
import { Cooldowns } from "./cooldown.ts";
import type { GatewayPolicy } from "./policy.ts";
import { ProviderAdmissionCore } from "./provider-admission-core.ts";
import {
	defaultFetchImpl,
	providerConcurrencyCodesOf,
	providerPoolIdOf,
} from "./router-attempt.ts";
import {
	type ExecuteResult,
	type RouterDeps,
	type RouterMetrics,
	type UpstreamRequest,
} from "./router-types.ts";
import { executeWalk } from "./router-walk.ts";

export { FLASHX } from "./policy.ts";
export {
	type ExecuteResult,
	type RouterDeps,
	type RouterMetrics,
	type TryOutcome,
	type UpstreamRequest,
	UpstreamError,
} from "./router-types.ts";
export { providerPoolIdOf } from "./router-attempt.ts";

export class Router {
	readonly cooldowns: Cooldowns;
	readonly now: () => number;
	readonly rng: () => number;
	readonly sleepMs: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly fetchImpl: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
	) => Promise<Response>;
	readonly metrics?: RouterMetrics;
	/** W1078: one admission core per explicitly configured account pool —
	 *  every deployment bound to the id shares the SAME instance (one
	 *  configured authority counts each actual provider attempt once). */
	readonly pools: Map<string, ProviderAdmissionCore>;

	constructor(
		readonly policy: GatewayPolicy,
		readonly deps: RouterDeps,
	) {
		this.cooldowns =
			deps.cooldowns ??
			new Cooldowns(
				policy.allowed_fails ?? 3,
				policy.cooldown_time ?? 30,
				deps.now,
			);
		this.now = deps.now ?? Date.now;
		this.rng = deps.rng ?? Math.random;
		this.sleepMs =
			deps.sleepMs ??
			((ms, signal) =>
				new Promise((resolve) => {
					if (signal?.aborted) return resolve();
					const timer = setTimeout(resolve, ms);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				}));
		this.fetchImpl = deps.fetchImpl ?? defaultFetchImpl;
		this.metrics = deps.metrics;
		// W1078: instantiate one core per explicitly configured account pool.
		// Bindings validate fail-closed here: a deployment bound to a pool
		// with no policy (or a malformed id) refuses startup — admission is
		// never silently disabled once configured.
		this.pools = new Map(
			Object.entries(policy.provider_pools ?? {}).map(([id, p]) => [
				id,
				new ProviderAdmissionCore(p),
			]),
		);
		for (const group of deps.pool.groups())
			for (const dep of deps.pool.deployments(group)) {
				providerConcurrencyCodesOf(dep, policy);
				if (dep.adapter_config?.provider_pool === undefined) continue;
				const id = providerPoolIdOf(dep);
				if (id === null || !this.pools.has(id))
					throw new Error(
						`router: deployment ${dep.group}/${dep.url} binds provider_pool "${String(dep.adapter_config?.provider_pool)}" with no matching gateway.provider_pools policy (W1078 admission is fail-closed)`,
					);
			}
	}
	providerAdmissionSnapshot() {
		return Object.fromEntries(
			[...this.pools].map(([id, core]) => [id, core.snapshot()]),
		);
	}
	/** Ladder walk entrypoint: the walk itself lives in router-walk.ts. */
	async execute(req: UpstreamRequest): Promise<ExecuteResult> {
		return executeWalk(this, req);
	}
}
