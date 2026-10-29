// hooks/lib/knowledge/promote-actor.ts — hub design D9: candidate → active
// is THE human gate (W142). Promotion names its actor (`--by <human>`), and
// the actor may not be a machine setter or a session id; a dispatched lane
// (its per-lane settings pin SUSPENDERS_LANE_EFFORT) can never promote.
// A guard, not a security boundary: it stops the accidental agent promote
// that made "active" mean nothing.

/** setter names the fleet's own machinery stamps — never a human. */
const MACHINE_ACTORS =
	/^(kev|coord|api-.*|decant-daily|knowledge-.*|ingest|lane-.*|agent|oracle|merge-ladder|fleet-loop)$/i;
/** session-id shaped: a full uuid or the 8-hex short sid. */
const SID_SHAPED =
	/^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8}|local_[0-9a-z-]+)$/i;
/** env keys only a dispatched lane carries. */
export const LANE_ENV_MARKERS = ["SUSPENDERS_LANE_EFFORT"] as const;

/** null = the actor may promote; otherwise the refusal reason. */
export function promoteActorError(
	by: string | null | undefined,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const lane = LANE_ENV_MARKERS.find((k) => env[k]);
	if (lane)
		return `promotion is a human gate — refused inside a lane (${lane})`;
	const who = by?.trim() ?? "";
	if (!who) return "promotion needs a human actor: --by <name>";
	if (MACHINE_ACTORS.test(who) || SID_SHAPED.test(who))
		return `'${who}' is a machine/session actor — promotion needs a human`;
	return null;
}
