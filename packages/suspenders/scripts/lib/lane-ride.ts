// W1712: the governed ride an argv-pinned executor (ExecutorAdapter.modelArgs)
// needs — the lane's own Buckle base (/w/<sid>/v1, applyLaneAttribution) and
// the minted lane key already in env. Without both the pin refuses: a pinned
// model never silently falls back to the executor's personal seat.
import type { EffortWord } from "../../hooks/lib/lanes/lane-effort-policy.ts";
import type { LaneRide } from "../../hooks/lib/lanes/lane.ts";

export type LaneRideOf =
	| { ok: true; ride: LaneRide }
	| { ok: false; why: string };

// a model id lands in a TOML-parsed argv override: refuse anything that could
// break out of the quoted string (a .prefer token must never re-point the provider)
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** The minted lane key's env NAME (applyLaneAttribution) — never its value. */
export const LANE_KEY_ENV = "ANTHROPIC_AUTH_TOKEN";

export const laneRideOf = (
	env: Record<string, string | undefined>,
	model: string,
	effort: EffortWord,
): LaneRideOf => {
	const base = env.OPENAI_BASE_URL ?? "";
	if (!/\/w\/[^/]+\/v1$/.test(base) || !env[LANE_KEY_ENV])
		return {
			ok: false,
			why: `${model} pin needs the governed Buckle front (/w/<sid> + minted lane key) — refusing a personal-seat substitution`,
		};
	if (!MODEL_ID.test(model))
		return {
			ok: false,
			why: `model pin ${JSON.stringify(model)} is not a model id`,
		};
	return { ok: true, ride: { model, base, keyEnv: LANE_KEY_ENV, effort } };
};
