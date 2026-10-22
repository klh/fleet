// scripts/lib/governance-decide.ts — W157 decomposition: the PURE lane
// governance decisions lifted from dispatch-next.ts (which keeps the impure
// readers — governanceMode()'s coord fact read, the front probe). Default is
// REFUSE: no scopes, no attribution, no budgets — governance never silently
// vanishes; belt-direct survives only as the explicit, loud, audited
// --allow-ungoverned operator override.
// W1119.2 (single-buckle-inference): the governance:solo belt-direct
// fallback at the front probe is RETIRED — an unreachable front refuses the
// lane in BOTH modes; solo relents nowhere (sessions still fold belt-direct
// loud via lane-auth session enrollment — the owner keeps working, lanes
// don't dispatch ungoverned).
import type { MintedLaneKey } from "./lane-auth.ts";

export type GovernanceDecision =
	| { mode: "governed"; key: string; keyId: string }
	| { mode: "ungoverned-override"; note: string }
	| { mode: "refuse"; why: string };

/** W463 fail-closed governance (pure — unit-testable): given the lane-key
 *  mint outcome and the operator override flag, what happens to the lane? */
export const laneKeyDecision = (
	minted: MintedLaneKey | null,
	allowUngoverned: boolean,
	govMode: "strict" | "solo" = "strict",
): GovernanceDecision => {
	if (minted) return { mode: "governed", key: minted.key, keyId: minted.keyId };
	if (allowUngoverned)
		return {
			mode: "ungoverned-override",
			note: "UNGOVERNED DISPATCH — operator override (--allow-ungoverned): buckle lane-key mint failed; lane rides belt direct with no buckle scopes, attribution or budgets",
		};
	return {
		mode: "refuse",
		// W422.17: solo relents only at the front probe, never at mint failures
		why:
			govMode === "solo"
				? "buckle lane-key mint failed — governance:solo does not relent at mint failures (fail-closed W463; --allow-ungoverned overrides)"
				: "buckle lane-key mint failed — check belt.env BUCKLE_ADMIN_KEY (fail-closed W463; --allow-ungoverned overrides)",
	};
};

/** W615 hub-won attribution decision (pure — unit-testable). The identity
 *  doc fix: a winning hub redirect no longer skips attribution — the lane
 *  mints its key AT the hub (the hub's KeyStore verifies only what it
 *  issued; the local belt.env admin means nothing there). Credential
 *  absence and mint failure are the W463 fail-closed matrix — solo relents
 *  ONLY where it relents locally (an unreachable HUB degrades to local belt
 *  upstream in resolveHub, before this decision), never at a credential
 *  failure. The ungoverned override keeps the operator's hub pin: the lane
 *  rides the hub base UNATTRIBUTED, loudly disclosed. */
export const hubAttributionDecision = (o: {
	hasToken: boolean;
	minted: MintedLaneKey | null;
	allowUngoverned: boolean;
}): GovernanceDecision => {
	if (o.minted)
		return { mode: "governed", key: o.minted.key, keyId: o.minted.keyId };
	if (o.allowUngoverned)
		return {
			mode: "ungoverned-override",
			note: "UNGOVERNED DISPATCH — operator override (--allow-ungoverned): hub lane-key mint failed; lane rides the hub unattributed — no buckle scopes, attribution or budgets",
		};
	return {
		mode: "refuse",
		why: o.hasToken
			? "hub lane-key mint failed — the hub's buckle admin did not issue a key (fail-closed W463; --allow-ungoverned overrides)"
			: "no hub credential — set SUSPENDERS_HUB_<LABEL>_TOKEN or the hubs.json token for the label (fail-closed W463; --allow-ungoverned overrides)",
	};
};

/** W422.17 (owner ruling 2026-10-06): `coord fact get fleet.governance`
 *  output → "strict" | "solo". Absent/unknown → strict (fail-closed
 *  default). Pure — unit-testable. */
export const parseGovernanceMode = (factOut: string): "strict" | "solo" => {
	const first = (factOut.split("\n")[0] ?? "").trim();
	if (first === "(unset)") return "strict";
	return first.replace(/\s*\(v\d+\)$/, "").trim() === "solo"
		? "solo"
		: "strict";
};

/** W422.17 probe-false decision (pure — unit-testable): the buckle front did
 *  not answer the probe. W1119.2 owner law (single-buckle-inference): the
 *  solo belt-direct fallback is retired — an unreachable front refuses the
 *  lane in BOTH governance modes; --allow-ungoverned stays the one explicit
 *  per-invocation override. */
export const probeFrontDecision = (
	allowUngoverned: boolean,
	govMode: "strict" | "solo",
): GovernanceDecision => {
	if (allowUngoverned)
		return {
			mode: "ungoverned-override",
			note: "UNGOVERNED DISPATCH — operator override (--allow-ungoverned): buckle front unreachable; lane rides belt direct with no buckle scopes, attribution or budgets",
		};
	return {
		mode: "refuse",
		why: `buckle front unreachable + governance:${govMode} — lanes dispatch only through the buckle front (single-buckle-inference W1119; --allow-ungoverned overrides per-invocation)`,
	};
};
