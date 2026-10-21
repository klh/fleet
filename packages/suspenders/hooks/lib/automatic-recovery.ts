// One fail-closed policy for every unattended claim recovery. The work graph
// remains authoritative; proxy traffic and transcript silence are not death.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "./govdb.ts";
import type { LaneRef } from "./lane-liveness.ts";
import { probeClaim } from "./reclaim-liveness.ts";
import {
	inspectLaunchIntent,
	launchIntent,
} from "../../scripts/lib/launch-fencing.ts";

export type AutomaticRecoveryClaim = {
	repo: string;
	store: GovernorStore;
	project: string;
	id: string;
	owner: string;
	revision: number;
	lane?: LaneRef;
};

export type AutomaticRecoveryDecision =
	| { ok: true; why: "dead" }
	| { ok: false; why: "paused" | "waiting" | "alive" | "unknown" };

export const automaticRecoveryPaused = (repo: string): boolean =>
	existsSync(join(repo, ".fleet", "reclaim-paused"));

/** Re-read this immediately before release, including inside the claim CAS
 * transaction. A stale preflight result cannot authorize a later reclaim. */
export function automaticRecoveryCheck(
	claim: AutomaticRecoveryClaim,
): AutomaticRecoveryDecision {
	if (automaticRecoveryPaused(claim.repo)) return { ok: false, why: "paused" };
	try {
		const session = claim.store
			.query("SELECT state FROM sessions WHERE sid=?")
			.get(claim.owner) as { state: string } | null;
		if (session && ["PAUSED", "WAIT_RATE"].includes(session.state))
			return { ok: false, why: "waiting" };
		const hasDecisions = claim.store
			.query(
				"SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='decisions'",
			)
			.get() as { found: number } | null;
		if (hasDecisions) {
			const open = claim.store
				.query(
					"SELECT 1 FROM decisions WHERE answer_to=? AND state='OPEN' LIMIT 1",
				)
				.get(claim.owner);
			if (open) return { ok: false, why: "waiting" };
		}
		const probe = probeClaim(claim.store, claim.project, {
			id: claim.id,
			owner: claim.owner,
			revision: claim.revision,
			lane: claim.lane,
		});
		if (probe.holdUntil !== null) return { ok: false, why: "waiting" };
		const verdict = probe.verdict;
		if (verdict !== "dead") return { ok: false, why: verdict };
		const intent = launchIntent(claim.store, claim.project, claim.id);
		if (intent) {
			if (intent.sid !== claim.owner) return { ok: false, why: "unknown" };
			if (inspectLaunchIntent(intent) !== "dead")
				return { ok: false, why: "unknown" };
		}
		return { ok: true, why: "dead" };
	} catch {
		return { ok: false, why: "unknown" };
	}
}
