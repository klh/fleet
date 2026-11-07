// hooks/lib/knowledge/trust-prior.ts — W2846 per-origin trust priors (the
// Apple PKG nm_hasConfidence lift): source reliability rides as DATA and
// multiplies into every landed fact. Three origin tiers, weights machine
// conf (config-over-code — knowledge.trust_priors), never code constants:
//   owner_verified — human-promoted rows (state active; the promote gate is
//                    human-only, promote-actor.ts — "owner-verified" names
//                    that promotion, the strongest signal the store has)
//   distilled      — machine-distilled rows (origin_kind 'distilled'; their
//                    confidence is single-model and capped at 0.6, W953)
//   lane_written   — everything else: raw lane/agent-written candidates
// The default ladder owner(1.0) > distilled(0.6) > lane(0.4) mirrors the
// store's own bands: promotion is the human act, distillation is one model
// pass, a lane candidate is unaudited. Exact origin_kind (lesson/incident/
// …) is content classification, not trust — the tier derivation ignores it.
import { setting } from "@klh/settings";

export type OriginTier = "owner_verified" | "distilled" | "lane_written";

export interface TrustPriors {
	owner_verified: number;
	distilled: number;
	lane_written: number;
}

/** The machine conf's trust priors (defaults: 1.0 / 0.6 / 0.4). */
export function trustPriors(): TrustPriors {
	const p = setting("knowledge.trust_priors");
	return {
		owner_verified: p.owner_verified,
		distilled: p.distilled,
		lane_written: p.lane_written,
	};
}

/** Which tier a row's own columns place it in — state is the promote act,
 *  origin_kind 'distilled' names the single-model pass, everything else is
 *  lane-written. Trust attaches to HOW a row came to be, never its topic. */
export function originTierOf(row: {
	state: string | null;
	origin_kind: string | null;
}): OriginTier {
	if (row.state === "active") return "owner_verified";
	if (row.origin_kind === "distilled") return "distilled";
	return "lane_written";
}

/** The prior weight for a row (config-over-code; unknowns stay lane). */
export function trustPriorOf(
	row: { state: string | null; origin_kind: string | null },
	priors: TrustPriors = trustPriors(),
): number {
	return priors[originTierOf(row)];
}

/** Ranked recall SQL: an addition to the bm25-side sort key (lower ranks
 *  better). Scaled ×8 so an adjacent tier gap (0.2 default) exceeds the
 *  content-prior axis' full range (ORIGIN_PRIOR_SQL max 1.5) — the source
 *  ladder orders equals without drowning a weaker text match, and bm25
 *  still leads when text relevance genuinely differs. */
const PRIOR_SCALE = 8;
export const trustPriorSql = (priors: TrustPriors): string =>
	`CASE WHEN k.state = 'active' THEN ${((1 - priors.owner_verified) * PRIOR_SCALE).toFixed(3)} WHEN k.origin_kind = 'distilled' THEN ${((1 - priors.distilled) * PRIOR_SCALE).toFixed(3)} ELSE ${((1 - priors.lane_written) * PRIOR_SCALE).toFixed(3)} END`;
