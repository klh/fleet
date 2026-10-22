// scripts/lib/attribution-posture.ts — W1063 decomposition (dispatch-next.ts
// rode the 1500-line law at 1499): the impure application of the
// W1/W463/W422.17/W615 attribution posture — hub-won mint AT the hub, front-up
// local mint, or the W422.17 probe-false branch. The pure decisions live in
// governance-decide.ts; this module applies them, and owns the tails the
// entrypoint kept repeating three times: the fail-closed refusal
// (governanceRefusals push + REFUSED lines), the loud ungoverned/belt-direct
// disclosure (*** lines + the brief rewrite the lane reads), and the 0600
// lane-key meta write. Behavior preserved.
import { chmodSync, writeFileSync } from "node:fs";
import { laneKeyDecision, probeFrontDecision } from "./governance-decide.ts";
import { attributeHubLane } from "./hub-lane.ts";
import { applyLaneAttribution, probeBuckleFront } from "./lane.ts";
import { ensureLaneKey, LANE_KEY_TTL_S, laneKeyMetaPath } from "./lane-auth.ts";

export type LaneAttributionOutcome =
	| { kind: "refused"; why: string; note: "" }
	| { kind: "disclosed"; note: string }
	| {
			kind: "attributed";
			note: string;
			/** cleanup-owned: revoke at launch-cleanup / retire. */
			ownedKeyId?: string;
			/** governed hub rides only — the hub front the lane answers on. */
			ownedKeyFront?: string;
	  };

/** Apply the attribution posture for one lane launch (W615/W463/W422.17).
 *  Refusals push onto `refusals` (the entrypoint's governanceRefusals) and
 *  come back as kind "refused" — the caller aborts the launch. Overrides and
 *  belt-direct rides come back as "disclosed" with the hubNote text;
 *  governed mints come back as "attributed" with the cleanup-owned key id
 *  and, hub-won only, the front. The brief rewrite on override/belt-direct
 *  happens HERE — the disclosure is IN the brief the lane reads (W463). */
export const applyLaneAttributionPosture = async (o: {
	sid: string;
	item: string;
	/** hub won the redirect — attribution mints AT the hub (W615). */
	hubWon: string | undefined;
	hubPick: string | null;
	hubUrl?: string;
	allowUngoverned: boolean;
	governance: "strict" | "solo";
	env: Record<string, string>;
	writtenFiles: Map<string, string>;
	refusals: string[];
	log: (msg: string) => void;
	brief: string;
	briefFile: string;
	wt: string;
	fleet: string;
}): Promise<LaneAttributionOutcome> => {
	// W463: the override is disclosed IN the brief the lane reads.
	const disclose = (note: string): void => {
		const disclosed = `${o.brief}\n\nGOVERNANCE: ${note}.\n`;
		writeFileSync(o.briefFile, disclosed);
		writeFileSync(`${o.wt}/.klh-brief.md`, disclosed);
	};
	const writeMeta = (meta: string): void => {
		const metaPath = laneKeyMetaPath(o.fleet, o.sid);
		o.writtenFiles.set(metaPath, meta);
		writeFileSync(metaPath, meta);
		chmodSync(metaPath, 0o600);
	};
	const refuse = (why: string): LaneAttributionOutcome => {
		o.refusals.push(o.item);
		console.log(
			`REFUSED ${o.item} — ${why}; launch refused; claim cleanup follows, nothing spawned`,
		);
		o.log(`REFUSED ${o.item} → ${o.sid} — ${why}`);
		return { kind: "refused", why, note: "" };
	};
	if (o.hubWon) {
		// W615 (lib/hub-lane.ts): mint AT the hub, ride <hub>/w/<sid> —
		// governed → env attribution + 0600 meta; override/refuse → the
		// W463 disclosure machinery, hub-worded.
		const hub = await attributeHubLane({
			sid: o.sid,
			hubLabel: o.hubPick ?? o.hubWon,
			hubUrl: o.hubUrl ?? o.hubWon,
			allowUngoverned: o.allowUngoverned,
			env: o.env,
		});
		if (hub.decision.mode === "governed") {
			writeMeta(hub.meta as string);
			return {
				kind: "attributed",
				note: `lane attribution: hub ${o.hubWon} /w/${o.sid} (scoped key, ttl ${LANE_KEY_TTL_S}s)`,
				ownedKeyId: hub.ownedKeyId,
				ownedKeyFront: o.hubUrl ?? o.hubWon,
			};
		}
		if (hub.decision.mode === "ungoverned-override") {
			console.log(`*** ${hub.decision.note} ***`);
			disclose(hub.decision.note);
			return { kind: "disclosed", note: hub.decision.note };
		}
		return refuse(hub.decision.why);
	}
	const frontUp: string | null = await probeBuckleFront();
	if (frontUp) {
		const decision = laneKeyDecision(
			await ensureLaneKey(o.sid),
			o.allowUngoverned,
			o.governance,
		);
		if (decision.mode === "governed") {
			applyLaneAttribution(o.env, o.sid, undefined, decision.key);
			writeMeta(
				`${JSON.stringify(
					{ sid: o.sid, key_id: decision.keyId, mintedAt: Date.now() },
					null,
					2,
				)}\n`,
			);
			return {
				kind: "attributed",
				note: `lane attribution: buckle front /w/${o.sid} (scoped key, ttl ${LANE_KEY_TTL_S}s)`,
				ownedKeyId: decision.keyId,
			};
		}
		if (decision.mode === "ungoverned-override") {
			console.log(`*** ${decision.note} ***`);
			disclose(decision.note);
			return { kind: "disclosed", note: decision.note };
		}
		return refuse(decision.why);
	}
	// W422.17 probe-false: the buckle front did not answer. Strict (the
	// default) refuses the lane with the same machinery as a mint
	// failure; solo keeps the belt-direct fallback — loud, disclosed.
	const probe = probeFrontDecision(o.allowUngoverned, o.governance);
	if (probe.mode === "refuse") return refuse(probe.why);
	console.log(`NOTE — ${probe.note}`);
	// ungoverned + belt-direct rides are disclosed IN the brief the lane reads.
	disclose(probe.note);
	return { kind: "disclosed", note: probe.note };
};
