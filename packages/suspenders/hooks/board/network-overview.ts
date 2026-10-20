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

/** /api/console/network payload — read model + the local spoke probe. */
export interface NetworkPayload {
	ok: true;
	ts: string;
	network: NetworkOverviewResult;
	/** The monitored buckle-4101 row (state + detail + recovery map), null
	 *  when the recovery map lacks the entry. */
	gateway: ReturnType<typeof withRecovery> | null;
}

export const NETWORK_GATEWAY_ID = "buckle-4101";

export async function networkPayload(): Promise<NetworkPayload> {
	const gateway =
		(await cachedProbes()).find((p) => p.id === NETWORK_GATEWAY_ID) ?? null;
	return {
		ok: true,
		ts: new Date().toISOString(),
		network: networkOverview(resolveNetworkDbPaths(process.env)),
		gateway: gateway ? withRecovery(gateway) : null,
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
