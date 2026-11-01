// hooks/lib/fleet-loop/kev-placement.ts — W2263: Kev-assisted lane
// placement over the live provider-neutral occupancy snapshot. The
// owner's directive: placement must SEE counts of admitted lanes by
// pool, cooldowns/walls and ceilings BEFORE choosing a lane model —
// never assume 8+8+8 configured maxima are 24 productive slots.
//
// Decision contract: build the snapshot (pools with headroom, cooling
// reasons, unknown-model lanes), ask kev ONE typed choice question over
// the eligible pools, and fall back deterministically (most headroom,
// then fewest recent 429s, then config order) when kev is unavailable
// or answers outside the option set — kev breaks fuzzy ties, the
// numbers stay authoritative. Owner pins are honored upstream: a pinned
// model enters here as the ONLY eligible candidate (never re-pinned
// across capability classes — cross-model fallback is opt-in via the
// pool capability tag). The reason string surfaces in the dispatch
// table and the lane.<sid>.placement fact.
import { kevTypedDecision } from "../knowledge/kev.ts";
import {
	type ProviderPools,
	automaticCeiling,
	poolCooling,
	poolOfModel,
	reservationKey,
} from "./provider-pools.ts";

export type PlacementCandidate = {
	/** reservation key (quota-collapsed pool id). */
	key: string;
	/** one representative model (the candidate's default lane pin). */
	model: string;
	/** headroom = ceiling − admitted automatic lanes. */
	headroom: number;
	ceiling: number;
	admitted: number;
};

export type PlacementSnapshot = {
	candidates: PlacementCandidate[];
	/** lanes admitted on a pool whose model is no longer listed. */
	unknownSlotLanes: number;
	/** provider penalty map (cooldown/quota) — read-only context. */
	cooling: Map<string, string>;
	/** active rate-limit walls (interactive contention symptom). */
	walls: number;
};

export type PlacementDecision = {
	model: string;
	poolKey: string;
	via: "kev" | "deterministic" | "pinned";
	reason: string;
};

/** Build the eligible candidate set from live occupancy: every pool with
 *  headroom ≥ 1 and no cooling evidence. A pinned model restricts the
 *  set to its own pool (owner pins are never rerouted — WAIT instead). */
export function placementCandidates(o: {
	pools: ProviderPools;
	counts: Map<string, number>;
	cooling: Map<string, string>;
	walls: number;
	pinnedModel: string | null;
}): PlacementSnapshot {
	const validKeys = new Set(
		Object.entries(o.pools).map(([id, p]) => reservationKey(id, p)),
	);
	const unknownSlotLanes = [...o.counts.entries()]
		.filter(([key]) => !validKeys.has(key))
		.reduce((n, [, c]) => n + c, 0);
	const snapshot: PlacementSnapshot = {
		candidates: [],
		unknownSlotLanes,
		cooling: o.cooling,
		walls: o.walls,
	};
	const pinned = o.pinnedModel ? poolOfModel(o.pools, o.pinnedModel) : null;
	for (const [id, pool] of Object.entries(o.pools)) {
		const key = reservationKey(id, pool);
		if (pinned && key !== pinned.key) continue;
		const ceiling = automaticCeiling(pool);
		const admitted = o.counts.get(key) ?? 0;
		if (admitted >= ceiling) continue;
		if (poolCooling(o.pools, id, o.cooling, o.walls)) continue;
		snapshot.candidates.push({
			key,
			model: pool.models[0] ?? id,
			headroom: ceiling - admitted,
			ceiling,
			admitted,
		});
	}
	return snapshot;
}

/** Deterministic fallback ranking: most headroom first, then fewest
 *  admitted (proportional load), then config declaration order. */
export const rankDeterministic = (
	candidates: PlacementCandidate[],
): PlacementCandidate[] =>
	[...candidates].sort(
		(a, b) => b.headroom - a.headroom || a.admitted - b.admitted,
	);

/** Render the cooling context for refusal reasons. */
const coolingLine = (cooling: Map<string, string>, walls: number): string =>
	`${[...cooling.entries()].map(([p, w]) => `${p}: ${w}`).join("; ") || "no provider cooldown"}; walls ${String(walls)}`;

/** One Kev-assisted placement pass over the live snapshot. kev picks
 *  among eligible pool keys; any failure falls to the deterministic
 *  rank. Zero candidates → ok:false with the reason (caller WAITs). */
export async function kevPlacement(o: {
	pools: ProviderPools;
	counts: Map<string, number>;
	cooling: Map<string, string>;
	walls: number;
	pinnedModel: string | null;
	timeoutMs?: number;
}): Promise<
	{ ok: true; decision: PlacementDecision } | { ok: false; reason: string }
> {
	// a pin outside every configured pool is ungoverned (opt-in pools) —
	// never rerouted, no ceiling
	if (o.pinnedModel && !poolOfModel(o.pools, o.pinnedModel))
		return {
			ok: true,
			decision: {
				model: o.pinnedModel,
				poolKey: "",
				via: "pinned",
				reason: `owner-pinned ${o.pinnedModel} not in any provider pool — no ceiling (opt-in)`,
			},
		};
	const snap = placementCandidates({
		pools: o.pools,
		counts: o.counts,
		cooling: o.cooling,
		walls: o.walls,
		pinnedModel: o.pinnedModel,
	});
	if (snap.candidates.length === 0) {
		const p = o.pinnedModel ? poolOfModel(o.pools, o.pinnedModel) : null;
		const stats = p
			? `pool ${p.key} ${o.counts.get(p.key) ?? 0}/${automaticCeiling(p.pool)} admitted`
			: "all pool ceilings full";
		return {
			ok: false,
			reason: `no eligible provider pool — ${stats} (${coolingLine(o.cooling, o.walls)}; unknown-slot lanes ${String(snap.unknownSlotLanes)}); WAIT, never reroute`,
		};
	}
	const ranked = rankDeterministic(snap.candidates);
	const best = ranked[0] as PlacementCandidate;
	if (o.pinnedModel) {
		const pinnedPool = poolOfModel(o.pools, o.pinnedModel);
		const pinned = snap.candidates.find((c) => c.key === pinnedPool?.key);
		if (pinned)
			return {
				ok: true,
				decision: {
					model: o.pinnedModel,
					poolKey: pinned.key,
					via: "pinned",
					reason: `owner-pinned ${o.pinnedModel} — pool ${pinned.key} ${pinned.admitted}/${pinned.ceiling} admitted, headroom ${String(pinned.headroom)}`,
				},
			};
	}
	const state = [
		`pools: ${snap.candidates
			.map(
				(c) =>
					`${c.key} ${c.admitted}/${c.ceiling} headroom ${String(c.headroom)}`,
			)
			.join("; ")}`,
		`cooling: ${[...o.cooling.entries()].map(([p, w]) => `${p} (${w})`).join("; ") || "none"}`,
		`rate-limit walls: ${String(o.walls)}`,
	].join("\n");
	const d = await kevTypedDecision({
		state,
		question:
			"Pick the provider pool for the next automatic fleet lane. Prefer most headroom and no cooling; avoid pools with rate-limit evidence.",
		options: snap.candidates.map((c) => ({
			label: c.key,
			tradeoff: `headroom ${String(c.headroom)}/${String(c.ceiling)} — ${c.model}`,
		})),
		...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
	});
	if (d) {
		const chosen = snap.candidates.find((c) => c.key === d.choice);
		if (chosen)
			return {
				ok: true,
				decision: {
					model: chosen.model,
					poolKey: chosen.key,
					via: "kev",
					reason: `kev ${d.model} chose ${chosen.key} (${Math.round(d.confidence * 100)}%) — ${chosen.admitted}/${chosen.ceiling} admitted, headroom ${String(chosen.headroom)}`,
				},
			};
	}
	return {
		ok: true,
		decision: {
			model: best.model,
			poolKey: best.key,
			via: "deterministic",
			reason: `deterministic — ${best.key} most headroom (${String(best.headroom)} of ${String(best.ceiling)}), ${String(best.admitted)} admitted`,
		},
	};
}
