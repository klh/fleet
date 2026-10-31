// reclaim-verb.ts — W2337: the per-item `work reclaim <id>` release body
// (automatic-recovery guard → observed release), extracted from bin/work.ts
// (1200-line stop rule, W1238.6). The strict automated path demands the full
// death verdict from automaticRecoveryCheck, re-read inside the CAS; the
// W2337 forced path (--force --justification, unknown verdict only) still
// refuses a verifiably live or waiting claimant — the operator never ghosts
// a live lane via --force — and records the justification in the sticky
// marker through the release audit.
import { automaticRecoveryCheck } from "../fleet-loop/automatic-recovery.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import type { LaneRef } from "../lanes/lane-liveness.ts";
import type { ReclaimReason } from "../lanes/reclaim-sticky.ts";
import { releaseWorkClaim } from "./work-release.ts";

export type ReclaimVerbArgs = {
	store: GovernorStore;
	project: string;
	repo: string;
	id: string;
	owner: string;
	state: string;
	updatedAt: number;
	reason: ReclaimReason;
	/** recorded on the forced path (W2337 audit trail) */
	justification?: string;
	force: boolean;
	/** fresh registry read inside the CAS guard — the claim may move */
	lane: () => LaneRef | undefined;
};

export type ReclaimVerbResult =
	| { ok: true; forced: boolean }
	| { ok: false; why: string };

export function releaseReclaimedClaim(a: ReclaimVerbArgs): ReclaimVerbResult {
	const read = () =>
		automaticRecoveryCheck({
			repo: a.repo,
			store: a.store,
			project: a.project,
			id: a.id,
			owner: a.owner,
			revision: a.updatedAt,
			lane: a.lane(),
		});
	const forced = a.reason !== "user" && a.force && !!a.justification?.trim();
	if (a.reason !== "user" && !read().ok && !forced)
		return {
			ok: false,
			why: `${a.id} automatic recovery refused — pause, wait, or death unverified`,
		};
	const guard =
		a.reason === "user"
			? undefined
			: forced
				? () => !["alive", "waiting"].includes(read().why)
				: () => read().ok;
	const released = releaseWorkClaim(
		a.store,
		{
			project: a.project,
			id: a.id,
			owner: a.owner || null,
			state: a.state,
			updatedAt: a.updatedAt,
		},
		{
			by: "operator-reclaim",
			reason: "operator-reclaim",
			cause: a.reason,
			...(forced && a.justification ? { justification: a.justification } : {}),
		},
		guard,
	);
	return released
		? { ok: true, forced }
		: {
				ok: false,
				why: `${a.id} claim changed — reclaim refused; inspect before retrying`,
			};
}
