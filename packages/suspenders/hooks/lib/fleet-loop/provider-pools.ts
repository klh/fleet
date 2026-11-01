// hooks/lib/fleet-loop/provider-pools.ts — W2263: provider-neutral
// per-pool capacity for lane admission. Machine conf (stack.json
// fleet_loop.provider_pools) declares pools; a pool SPANS model aliases
// and hubs that share one physical credential/account (owner verified
// every zai row rides the same key/account — counting each alias as its
// own ceiling oversubscribes the account). A pool's automatic-lane
// ceiling is `concurrency - interactive_reserve`: the reserve is
// configurable headroom interactive + review traffic may consume
// (traffic-class fairness knob), never lent to lanes.
//
// Hub multiplicity is NOT capacity (#89298): every hub profile and both
// transports (direct + relayed) that load the same credential file join
// the ONE reservation key — quota_pool_id is the operator's explicit
// statement of that shared account when fingerprints disagree.
//
// Admission runs at the ONE common launch path (lane-launch.ts) — both
// fleet-loop refill and explicit --item dispatch ride dispatchLane, so a
// pool reservation fences EVERY lane launch, not only loop-driven
// refill. The occupancy read + reservation write ride ONE store
// transaction (posture.admission precedent): two concurrent dispatchers
// cannot double-book a ceiling. Full pool = WAIT with the counts, never
// a silent reroute; an owner-pinned model whose pool is full waits.
// Configured ceilings are CEILINGS, not proven throughput — the staged
// ramp (scripts/lib/pool-ramp-plan.ts) plus the negative-results log
// gate any raise of production concurrency.
import type { GovernorStore } from "../govdb/govdb.ts";
import type { StackConfig } from "../stack-config.ts";
import { providerOf } from "../usage/exec-quota.ts";
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

/** The machine conf's provider_pools block — empty map when none is
 *  configured (pools are opt-in; unlisted models ride no ceiling, loud at
 *  the launch path), malformed configuration throws loud (posture law:
 *  error, never silent fallback). */
export function resolveProviderPools(
	stack: StackConfig | null | undefined,
): ProviderPools {
	const raw = stack?.fleet_loop?.provider_pools;
	if (!raw) return {};
	const parsed = ProviderPoolsSchema.safeParse(raw);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map(
				(i) =>
					`fleet_loop.provider_pools.${i.path.join(".") || "$"}: ${i.message}`,
			)
			.join("; ");
		throw new Error(`stack.json ${details}`);
	}
	// one alias may not name two DIFFERENT physical pools — ambiguous
	// membership is operator error, loud (first-wins would hide it).
	const owner: Record<string, string> = {};
	for (const [id, pool] of Object.entries(parsed.data)) {
		for (const m of pool.models) {
			const key = m.toLowerCase();
			if (owner[key] && owner[key] !== reservationKey(id, pool))
				throw new Error(
					`stack.json fleet_loop.provider_pools: model ${m} belongs to both ${owner[key]} and ${reservationKey(id, pool)} — one alias, one pool`,
				);
			owner[key] = reservationKey(id, pool);
		}
	}
	return parsed.data;
}

/** The reservation-ledger key: an explicit quota_pool_id collapses pool
 *  entries that share one physical quota (owner-verified aliasing). */
export const reservationKey = (id: string, pool: ProviderPool): string =>
	pool.quota_pool_id ?? id;

/** The pool a model rides — null when unlisted (opt-in). */
export function poolOfModel(
	pools: ProviderPools,
	model: string | null,
): { id: string; pool: ProviderPool; key: string } | null {
	if (!model) return null;
	for (const [id, pool] of Object.entries(pools)) {
		if (pool.models.some((m) => m.toLowerCase() === model.toLowerCase()))
			return { id, pool, key: reservationKey(id, pool) };
	}
	return null;
}

/** Automatic-lane ceiling: concurrency minus the interactive/review
 *  reserve (validated ≥ 1 at parse). */
export const automaticCeiling = (pool: ProviderPool): number =>
	pool.concurrency - (pool.interactive_reserve ?? 0);

/** A lane entry (reservation) by a not-yet-running lane still counts —
 *  posture.admission window precedent. */
export const POOL_RESERVED_WINDOW_MS = 30 * 60_000;

export type PoolOccupancy = {
	/** reservation key → admitted lanes (running + reserved + fresh). */
	counts: Map<string, number>;
};

/** Per-pool admitted-lane counts over the dispatch facts: a lane holds a
 *  pool slot while its session is RUNNING, its launch intent is alive,
 *  or its reservation stamp is inside the window (claimed ≠ productive —
 *  counts are ADMISSIONS, never throughput). */
export function poolOccupancy(
	store: GovernorStore,
	pools: ProviderPools,
	now = Date.now(),
): PoolOccupancy {
	const live = new Set<string>();
	for (const r of store
		.query("SELECT sid FROM sessions WHERE state='RUNNING'")
		.all() as { sid: string }[])
		live.add(r.sid);
	try {
		for (const r of store
			.query("SELECT sid FROM lane_launch_intents")
			.all() as { sid: string }[])
			live.add(r.sid);
	} catch {} // pre-intents db — no reserved evidence
	// sid → reservation key; a lane stamped by this module carries BOTH a
	// pool and a model fact — each sid counts ONCE (pool fact wins).
	const bySid = new Map<string, string>();
	for (const r of store
		.query("SELECT key, value, ts FROM facts WHERE key GLOB 'lane.*.pool'")
		.all() as { key: string; value: string; ts: number }[]) {
		const sid = r.key.slice("lane.".length, -".pool".length);
		if (!live.has(sid) && r.ts < now - POOL_RESERVED_WINDOW_MS) continue;
		bySid.set(sid, r.value);
	}
	// legacy lanes stamped before pools existed carry only a model fact
	for (const r of store
		.query("SELECT key, value, ts FROM facts WHERE key GLOB 'lane.*.model'")
		.all() as { key: string; value: string; ts: number }[]) {
		const sid = r.key.slice("lane.".length, -".model".length);
		if (!live.has(sid) && r.ts < now - POOL_RESERVED_WINDOW_MS) continue;
		if (bySid.has(sid)) continue; // pool fact already counted this sid
		const p = poolOfModel(pools, r.value);
		if (p) bySid.set(sid, p.key);
	}
	const counts = new Map<string, number>();
	for (const key of bySid.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
	return { counts };
}

/** Stamp the placement decision audit fact (lane.<sid>.placement). */
export function recordPlacementReason(
	store: GovernorStore,
	sid: string,
	reason: string,
): void {
	store
		.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		)
		.run(`lane.${sid}.placement`, reason, Date.now());
}

/** Cooldown evidence: a live provider penalty (zai cooldown fact, quota
 *  cliff) on ANY member model's provider, or active rate-limit walls —
 *  the interactive-contention symptom surfacing in the lane plane. */
export function poolCooling(
	pools: ProviderPools,
	id: string,
	penalty: Map<string, string>,
	walls: number,
): string | null {
	if (walls > 0) return `${walls} active rate-limit wall(s) (W1025)`;
	const pool = pools[id];
	if (!pool) return null;
	for (const m of pool.models) {
		const why = penalty.get(providerOf(m) ?? "");
		if (why) return `${m}: ${why}`;
	}
	return null;
}

export type PoolAdmission =
	| {
			ok: true;
			key: string;
			reason: string;
	  }
	| { ok: false; reason: string };

/** Fenced pool reservation for one launch: inside ONE transaction, count
 *  admitted lanes on the pool's reservation key and stamp the slot when
 *  headroom exists. WAIT-never-reroute — placement (a separate decision)
 *  proposes pools; this only enforces ceilings. */
export function reservePoolSlot(o: {
	store: GovernorStore;
	pools: ProviderPools;
	sid: string;
	model: string | null;
}): PoolAdmission {
	const p = poolOfModel(o.pools, o.model);
	if (!p)
		return {
			ok: true,
			key: "",
			reason: "model not in any provider pool — no ceiling (opt-in)",
		};
	const ceiling = automaticCeiling(p.pool);
	return o.store.transaction(() => {
		const { counts } = poolOccupancy(o.store, o.pools);
		const admitted = counts.get(p.key) ?? 0;
		if (admitted >= ceiling)
			return {
				ok: false,
				reason: `provider pool ${p.key} full — ${admitted}/${ceiling} automatic-lane slots admitted (running+reserved, across aliases; concurrency ${p.pool.concurrency}, interactive reserve ${p.pool.interactive_reserve ?? 0}); WAIT, never reroute`,
			};
		o.store
			.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
			)
			.run(`lane.${o.sid}.pool`, p.key, Date.now());
		return {
			ok: true,
			key: p.key,
			reason: `provider pool ${p.key} slot ${admitted + 1}/${ceiling}`,
		};
	})();
}
