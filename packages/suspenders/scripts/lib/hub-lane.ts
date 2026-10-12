// scripts/lib/hub-lane.ts — W615 hub-won lane attribution. The identity-doc
// fix: a winning hub redirect no longer skips buckle attribution — the lane
// mints its key AT the hub (the hub's KeyStore verifies only what it issued;
// the local belt.env admin means nothing there) and rides <hub-url>/w/<sid>,
// so hub-routed usage lands in the hub's own route_audit.lane. Credential +
// posture = hubAttributionDecision (fail-closed W463; the ungoverned
// override keeps the operator's hub pin, riding the hub UNATTRIBUTED).
import {
	hubAttributionDecision,
	type GovernanceDecision,
} from "./governance-decide.ts";
import { applyLaneAttribution } from "./lane.ts";
import { hubCredential, mintLaneKey } from "./lane-auth.ts";

export interface HubAttribution {
	decision: GovernanceDecision;
	/** governed only — revoke at launch-cleanup / retire, at the hub. */
	ownedKeyId?: string;
	/** governed only — the 0600 lane-key meta payload (front + hub recorded
	 *  so retire revokes at the minting hub with the hub credential). */
	meta?: string;
}

/** Resolve the hub credential, mint the lane key at the hub front, decide
 *  the posture; on governed, apply the /w/<sid> attribution onto the lane
 *  env. Pure-ish (fetch injectable for tests via mintLaneKey's default). */
export const attributeHubLane = async (o: {
	sid: string;
	hubLabel: string;
	hubUrl: string;
	allowUngoverned: boolean;
	env: Record<string, string>;
	fetchFn?: typeof fetch;
}): Promise<HubAttribution> => {
	const hubToken = hubCredential(o.hubLabel);
	const decision = hubAttributionDecision({
		hasToken: hubToken !== null,
		minted: hubToken
			? await mintLaneKey(o.sid, hubToken, o.fetchFn ?? fetch, o.hubUrl)
			: null,
		allowUngoverned: o.allowUngoverned,
	});
	if (decision.mode !== "governed") return { decision };
	applyLaneAttribution(o.env, o.sid, o.hubUrl);
	o.env.ANTHROPIC_AUTH_TOKEN = decision.key;
	return {
		decision,
		ownedKeyId: decision.keyId,
		meta: `${JSON.stringify(
			{
				sid: o.sid,
				key_id: decision.keyId,
				mintedAt: Date.now(),
				front: o.hubUrl,
				hub: o.hubLabel,
			},
			null,
			2,
		)}\n`,
	};
};
