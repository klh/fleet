// fleet-loop/reclaim-sweep.ts — W376: the per-cycle auto-reclaim pass. Runs
// the `work reclaim all` core (lib/reclaim-all.ts — the W339 verb's bulk
// operation with W610 liveness parity: 3 consecutive dead passes, extend
// lease honored, unknown never releases) over the loop's project, so stale
// claims return to READY without an operator pass and dispatch refills them
// same-cycle. Releases broadcast fleet-wide (the ONE coord broadcast, 24h
// note-dedupe). The caller fail-isolates the sweep (the wisdom-sweep rule).
import { projectIdentity } from "../govdb.ts";
import { reclaimAll } from "../reclaim-all.ts";
import type { GovernorStore } from "../govdb.ts";
import type { LoopDeps } from "./runtime.ts";

export function createReclaimSweep(
	deps: LoopDeps & {
		broadcast: (note: string) => unknown;
		store: () => GovernorStore;
	},
): { reclaimSweep: () => void } {
	const { REPO, log, broadcast, store } = deps;
	return {
		reclaimSweep: () => {
			const r = reclaimAll(store(), projectIdentity(REPO), REPO);
			const released = r.filter((x) => x.action === "released");
			if (released.length === 0) return;
			const ids = released.map((x) => x.id).join(", ");
			log(`RECLAIM ${ids} → READY (auto-reclaim pass)`);
			broadcast(
				`reclaim-all: ${ids} reclaimed → READY (orphaned claims, fleet-loop auto-reclaim pass)`,
			);
		},
	};
}
