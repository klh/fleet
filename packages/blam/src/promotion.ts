// src/promotion.ts — W458.5: promotion evals + rollback authority for the
// starter registry (architecture record:
// packages/suspenders/docs/starter-milestone-w458-6.md). Laws:
// - a BLAM evaluation gates every promotion: the criterion is a measured
//   paired lift on comparable work — self-reported confidence can never
//   reach this gate (it takes a Lift, not an opinion);
// - the lift must be decision-grade: enough reps, no correctness
//   regression, and a benefit with sign agreement across reps;
// - every promoted version carries an explicit rollback target: the newest
//   prior version, resolved at promotion-recording time — refusal is
//   observable when no target exists.
import type { Lift } from "../bench/paired/types.ts";

export type PromotionPolicy = {
	/** Minimum paired repetitions before the lift is even measurable. */
	minReps: number;
	/** Maximum tolerated correctness delta (negative = the candidate fixes
	 *  fewer tasks). Default 0 — no regression allowed. */
	maxCorrectRegression: number;
};

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
	minReps: 3,
	maxCorrectRegression: 0,
};

export type PromotionDecision = { promote: boolean; why: string };

/** THE promotion criterion. Positive token/minute delta = the candidate
 *  saves; sign agreement (tokensSavedReps) guards against one lucky rep
 *  carrying the mean. Self-reported confidence has no parameter here —
 *  the signature is the enforcement. */
export const gatePromotion = (
	lift: Lift,
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionDecision => {
	if (lift.reps < policy.minReps)
		return {
			promote: false,
			why: `underpowered: ${lift.reps} reps < ${policy.minReps}`,
		};
	if (lift.correctDelta < policy.maxCorrectRegression)
		return {
			promote: false,
			why: `correctness regression: ${lift.correctDelta.toFixed(3)} < ${policy.maxCorrectRegression}`,
		};
	const saves = lift.tokensSaved > 0 || lift.minutesSaved > 0;
	if (!saves)
		return {
			promote: false,
			why: "no measured benefit (tokens and minutes both flat or negative)",
		};
	if (lift.tokensSaved > 0 && lift.tokensSavedReps * 2 <= lift.reps)
		return {
			promote: false,
			why: `no sign agreement: tokens saved in ${lift.tokensSavedReps}/${lift.reps} reps`,
		};
	return { promote: true, why: `measured lift over ${lift.reps} paired reps` };
};

export type VersionRef = {
	version: number;
	digest: string;
	createdAt: string;
};

export type RollbackPlan = {
	starter: string;
	from: number;
	to: number;
	fromDigest: string;
	toDigest: string;
};

/** Resolve the explicit rollback target for a candidate: the NEWEST prior
 *  version (the registry is append-only, so "rollback" means "point at the
 *  last good version and revoke the bad one" — never a rewrite). */
export const rollbackTargetOf = (
	starter: string,
	versions: VersionRef[],
	candidate: number,
): RollbackPlan | { refused: string } => {
	const priors = versions
		.filter((v) => v.version < candidate)
		.sort((a, b) => b.version - a.version);
	const to = priors[0];
	const from = versions.find((v) => v.version === candidate);
	if (!from)
		return { refused: `unknown candidate version ${candidate} of ${starter}` };
	if (!to)
		return {
			refused: `no rollback target: ${starter} v${candidate} has no prior version`,
		};
	return {
		starter,
		from: from.version,
		to: to.version,
		fromDigest: from.digest,
		toDigest: to.digest,
	};
};
