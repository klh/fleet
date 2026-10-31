// hooks/lib/fleet-loop/model-admission.ts — W2278: the ONE admission gate
// for a chosen lane model on the common launch path. Extracted from
// lane-launch.ts during the parked/W2263 rebase so lane-launch stays under
// the 1200-line stop rule (W1238.6). Gates run in order and each may block
// the launch: W2263 pool placement may reroute the MODEL, W1712 wire-pick
// may switch the EXECUTOR to one that speaks the final model's wire, and
// route admission gates on route health for the final model. WAIT = the
// launch retries next cycle; REFUSED = nothing claimed or minted.
import type { GovernorStore } from "../govdb/govdb.ts";
import { tryLoadStack } from "../stack-config.ts";
import { activeRateLimitWalls } from "../../../scripts/lib/launch-backoff.ts";
import {
	resolveProviderPools,
	poolOccupancy,
	recordPlacementReason,
	reservePoolSlot,
} from "./provider-pools.ts";
import { kevPlacement } from "./kev-placement.ts";
import {
	type GroupEndpoints,
	wirePick,
} from "../../../scripts/lib/lane-wire.ts";
import type { execPick } from "../../../scripts/lib/exec-chain.ts";
import { laneModelOf } from "../../../scripts/lib/dispatch-executor-note.ts";
import { resolveLaneExecutor } from "../../../scripts/lib/launch-preflight.ts";
import type { RouteAdmission } from "../../../scripts/lib/dispatch-admission.ts";
import type { ProviderPenalty } from "../usage/exec-quota.ts";

/** The launch-path pick shape (exec-chain execPick result). */
type LanePick = ReturnType<typeof execPick>;

export type ModelAdmission =
	| { verdict: "proceed"; pick: LanePick; bin: string | null }
	| { verdict: "wait"; reason: string }
	| { verdict: "refused"; reason: string };

/** Run the model admission gates for one launch attempt. Lists (refusals
 *  and waits) are pushed inside; the caller just branches on the verdict —
 *  refusal paths close the store themselves (verbatim from lane-launch). */
export async function admitModel(io: {
	store: GovernorStore;
	project: string;
	sid: string;
	item: string;
	pick: LanePick;
	bin: string | null;
	routePin: string | undefined;
	posture: string;
	quota: ProviderPenalty;
	wireEndpoints: GroupEndpoints;
	routeName: string | null;
	routeAdmission: RouteAdmission;
	governanceRefusals: string[];
	launchWaits: string[];
}): Promise<ModelAdmission> {
	const {
		store,
		project,
		sid,
		item,
		routePin,
		posture,
		quota,
		wireEndpoints,
		routeName,
		routeAdmission,
		governanceRefusals,
		launchWaits,
	} = io;
	let pick = io.pick;
	let bin = io.bin;

	// W2263 provider pools: placement sees the live occupancy/cooldown
	// snapshot BEFORE the model is chosen; owner pins (dotfile
	// must/prefer/can, --route) are never rerouted — a full pinned
	// pool WAITs. Unlisted models ride no ceiling (opt-in pools).
	const pools = resolveProviderPools(tryLoadStack());
	if (Object.keys(pools).length > 0) {
		// plaid's route pick already carries health evidence — treat it
		// as pinned so placement gates/reserves but never reroutes it
		const pinnedModel =
			routePin ??
			(pick.preference.source === "dotfile" || posture === "plaid"
				? laneModelOf(pick)
				: null);
		const { counts } = poolOccupancy(store, pools);
		const walls = activeRateLimitWalls(store, project);
		const placement = await kevPlacement({
			pools,
			counts,
			cooling: quota,
			walls,
			pinnedModel,
		});
		if (!placement.ok) {
			launchWaits.push(item);
			console.log(`WAIT ${item} — ${placement.reason}`);
			return { verdict: "wait", reason: placement.reason };
		}
		if (
			placement.decision.via !== "pinned" &&
			placement.decision.model !== pick.model
		) {
			console.log(
				`NOTE — placement: ${pick.model ?? "(default ladder)"} → ${placement.decision.model} (${placement.decision.reason})`,
			);
			pick = { ...pick, model: placement.decision.model };
		} else console.log(`NOTE — placement: ${placement.decision.reason}`);
		recordPlacementReason(store, sid, placement.decision.reason);
		// fenced reservation: the tx re-reads occupancy and stamps the
		// slot — concurrent dispatchers cannot double-book a ceiling.
		// A later launch failure leaves the slot to the 30-min window.
		const slot = reservePoolSlot({
			store,
			pools,
			sid,
			model: laneModelOf(pick),
		});
		if (!slot.ok) {
			launchWaits.push(item);
			console.log(`WAIT ${item} — ${slot.reason}`);
			return { verdict: "wait", reason: slot.reason };
		}
	}

	// W1712: the executor must speak the pinned model's wire. A steady
	// model pin rides the default CLI, so a provably unserved wire moves
	// the SAME model to a carrier that speaks it; a plaid route's explicit
	// executor+model pairing refuses instead.
	const wire = await wirePick(pick, wireEndpoints, routeName === null);
	if (!wire.ok) {
		governanceRefusals.push(item);
		console.log(`REFUSED ${item} — ${wire.why}; nothing claimed or minted`);
		store.close();
		return { verdict: "refused", reason: wire.why };
	}
	if (wire.switched) {
		console.log(
			`NOTE — wire: ${pick.model} rides ${wire.bin} (${pick.bin} cannot speak its wire)`,
		);
		pick = { ...pick, bin: wire.bin, fallbackModels: [] };
		bin = resolveLaneExecutor(pick.bin);
		if (!bin) {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — executor unavailable: ${pick.bin}; nothing claimed or minted`,
			);
			store.close();
			return {
				verdict: "refused",
				reason: `executor unavailable: ${String(pick.bin)}`,
			};
		}
	}
	const route = await routeAdmission.check(pick.model);
	if (route.pause) {
		const why =
			route.reason ??
			`${pick.model} has ${route.failures} recent, exactly attributed route refusals; retry when evidence clears`;
		console.log(`WAIT ${item} — ${why}`);
		launchWaits.push(item);
		return { verdict: "wait", reason: why };
	}
	return { verdict: "proceed", pick, bin };
}
