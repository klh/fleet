// hooks/lib/gates/review-model-select.ts — W2948: the review model choice as
// ONE auditable function. The 2026-11-10 loop.log specimen: dozens of DONE
// branches deferred with "review unavailable: configure
// SUSPENDERS_REVIEW_MODEL or restore original lane model fact" — the launchd
// fleet-loop carries no SUSPENDERS_REVIEW_MODEL and the machine conf declared
// only a fallback ladder, no primary. Two corrections, both config-over-code:
// a conf primary (fleet_loop.review_model, hot-reloaded with the rest of the
// block) and, when the author's lane model fact is gone, a SAFE pick from the
// already-configured fallback ladder. No model is ever invented: nothing
// configured = the same loud refusal, now naming every source it checked.
import {
	PROTECTED_REVIEW_CLASS,
	protectedFamilyRefusal,
} from "./protected-family.ts";
import { wireModelMatch } from "./wire-model-check.ts";

/** Where the chosen model came from — rendered into the scheduler's
 *  operator-facing line so a surprising pin is traceable to its source. */
export type ReviewModelSource =
	| "env"
	| "lane-fact"
	| "conf"
	| "conf-fallback-list";

export interface ReviewModelChoice {
	model?: string;
	source?: ReviewModelSource;
	/** One operator-facing line: the pick and its source, or every source
	 *  that was checked and found empty. */
	diagnosis: string;
}

/** CSV ladder → trimmed, non-empty entries (the env/conf rows share one
 *  shape, as reviewSpawnEnv already assumes). */
export const ladderModels = (csv: string | undefined): string[] =>
	(csv ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

/** The review model for one request, in precedence order:
 *  env override → the completion author's lane model fact → the machine
 *  conf primary → the first ADMISSIBLE rung of the configured fallback
 *  ladder. A protected-family item only ever accepts the full review class
 *  (W2571): its ladder pick skips flash/stepdown rungs instead of demoting,
 *  and an empty admissible set refuses loudly rather than inventing one. */
export function selectReviewModel(o: {
	env: NodeJS.ProcessEnv;
	/** `lane.<author>.model` fact value, when it still exists. */
	pin?: string;
	/** fleet_loop.review_model — the machine-conf primary. */
	confModel?: string;
	/** fleet_loop.review_fallback_models (env row wins, as at spawn). */
	fallbackModels?: string;
	protectedItem: boolean;
}): ReviewModelChoice {
	const envModel = o.env.SUSPENDERS_REVIEW_MODEL?.trim();
	if (envModel)
		return {
			model: envModel,
			source: "env",
			diagnosis: `review model ${envModel} (SUSPENDERS_REVIEW_MODEL)`,
		};
	const pin = o.pin?.trim();
	if (pin)
		return {
			model: pin,
			source: "lane-fact",
			diagnosis: `review model ${pin} (completion author lane model fact)`,
		};
	const confModel = o.confModel?.trim();
	if (confModel)
		return {
			model: confModel,
			source: "conf",
			diagnosis: `review model ${confModel} (machine conf fleet_loop.review_model)`,
		};
	const ladder = ladderModels(
		o.env.SUSPENDERS_REVIEW_FALLBACK_MODELS ?? o.fallbackModels,
	);
	const admissible = o.protectedItem
		? ladder.filter(
				(model) => wireModelMatch(model, PROTECTED_REVIEW_CLASS) === "match",
			)
		: ladder;
	const picked = admissible[0];
	if (picked)
		return {
			model: picked,
			source: "conf-fallback-list",
			diagnosis: `review model ${picked} (first${
				o.protectedItem ? ` ${PROTECTED_REVIEW_CLASS}-class` : ""
			} rung of the configured review fallback ladder — author lane model fact absent)`,
		};
	if (o.protectedItem && ladder.length > 0)
		return { diagnosis: protectedFamilyRefusal(undefined) };
	return { diagnosis: reviewModelUnavailable(ladder.length > 0) };
}

/** The loud refusal, naming every source the selector checked — the
 *  operator-facing diagnosis the 2026-11-10 specimen lacked. */
export const reviewModelUnavailable = (ladderPresent: boolean): string =>
	`review unavailable: no review model configured — SUSPENDERS_REVIEW_MODEL unset, completion author lane model fact absent, machine conf fleet_loop.review_model unset, review fallback ladder ${
		ladderPresent ? "yielded no admissible rung" : "unset"
	}. Set fleet_loop.review_model in ~/.config/klh/settings.json (hot-reloaded) or export SUSPENDERS_REVIEW_MODEL.`;
