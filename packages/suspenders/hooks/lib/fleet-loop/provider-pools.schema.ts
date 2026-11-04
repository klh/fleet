// hooks/lib/fleet-loop/provider-pools.schema.ts — W2753: the W2263 pool
// shapes moved to @klh/settings (settings.stack.ts) so the settings
// FleetLoopSchema section carries provider_pools at the source. This module
// is the suspenders-side re-export — every importer (provider-pools.ts,
// model-admission.ts, kev-placement.ts, pool-ramp-plan.ts, stack-config.ts)
// keeps its import path and shape.
export {
	type ProviderPool,
	type ProviderPools,
	ProviderPoolSchema,
	ProviderPoolsSchema,
} from "@klh/settings";
