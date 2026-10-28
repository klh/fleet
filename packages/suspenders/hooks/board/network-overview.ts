// hooks/board/network-overview.ts — W858.10.3: the /console/buckle Network
// overview payload. Buckle's own request/usage records read through the
// network read model (ledger + projection dbs), plus the live gateway probe
// row for the local spoke — the board's monitored-service probe reused, so
// the browser never fetches :4101 cross-origin. Absent dbs = honest
// ok:false; unavailable beats zero.
import {
	type NetworkOverviewResult,
	networkOverview,
	resolveNetworkDbPaths,
} from "../../../buckle/src/network-read-model.ts";
import { topologySnapshot } from "../../../buckle/src/topology-read-model.ts";
import { cachedProbes } from "./console-view.ts";
import { withRecovery } from "./service-probe.ts";
import { db } from "./context.ts";
import { downModelGroups } from "../lib/hub/model-health.ts";

/** /api/console/network payload — read model + the local spoke probe. */
export interface NetworkPayload {
	ok: true;
	ts: string;
	network: NetworkOverviewResult;
	/** The monitored buckle-4101 row (state + detail + recovery map), null
	 *  when the recovery board db lacks the entry. */
	gateway: ReturnType<typeof withRecovery> | null;
	/** W2194: model groups the health sweep currently grades DOWN (fresh
	 *  facts only — stale facts age out of the DOWN display). */
	model_health: { down: string[] };
}

export const NETWORK_GATEWAY_ID = "buckle-4101";

export async function networkPayload(): Promise<NetworkPayload> {
	const gateway =
		(await cachedProbes()).find((p) => p.id === NETWORK_GATEWAY_ID) ?? null;
	let down: string[] = [];
	try {
		down = downModelGroups(db);
	} catch {
		// fail-soft: the card renders the absent state — unavailable beats
		// a false all-up (the payload's own honesty law).
	}
	return {
		model_health: { down },
		gateway: gateway ? withRecovery(gateway) : null,
		network: networkOverview(resolveNetworkDbPaths(process.env)),
		ok: true,
		ts: new Date().toISOString(),
	};
}

/** Versioned observed graph for topology clients; no configured link is
 * presented as measured traffic. */
export function topologyPayload() {
	return topologySnapshot(
		resolveNetworkDbPaths(process.env),
		Date.now,
		process.env.BUCKLE_HUB_ID ?? "local",
	);
}
