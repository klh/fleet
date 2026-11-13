// hooks/lib/fleet-loop/provider-pools.schema.ts — the zod shapes for the
// W2263 provider_pools conf block, split from provider-pools.ts so the
// config layer (stack-config.ts) depends on schemas ONLY. The flat-home
// closure law (W2343: one basename per flat home) made the monolith's
// transitive admission machinery (executors/registry.ts, since renamed
// executor-registry.ts by W2459) collide with
// belt's own registry.ts member — posture.zod.ts is the precedent: conf
// schemas live beside their domain, dependency-free of the runtime.
import { z } from "zod";

const IDENT =
	/^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const ProviderPoolSchema = z
	.strictObject({
		/** Model aliases riding this pool (any hub — pool identity is the
		 *  shared credential, not the hub or the alias). */
		models: z.array(z.string().regex(IDENT)).min(1),
		/** Max concurrent lanes (running + reserved) across the pool. */
		concurrency: z.number().int().positive(),
		/** Headroom reserved for interactive/review traffic (default 0). */
		interactive_reserve: z.number().int().nonnegative().optional(),
		/** Explicit quota-pool key: pool entries sharing a quota_pool_id
		 *  share ONE reservation ledger (alias collapse, owner directive). */
		quota_pool_id: z.string().regex(IDENT).optional(),
		/** Capability tag: placement may only re-pin inside the same tag. */
		capability: z.string().regex(IDENT).optional(),
	})
	.refine((p) => p.concurrency > (p.interactive_reserve ?? 0), {
		message: "interactive_reserve must leave at least 1 lane slot",
		path: ["interactive_reserve"],
	});

export const ProviderPoolsSchema = z.record(
	z.string().regex(IDENT),
	ProviderPoolSchema,
);

export type ProviderPool = z.infer<typeof ProviderPoolSchema>;
export type ProviderPools = Record<string, ProviderPool>;
