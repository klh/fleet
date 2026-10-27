// fleet-loop/reclaim-sweep.ts — W376: the per-cycle auto-reclaim pass. Runs
// the `work reclaim all` core (lib/reclaim-all.ts — the W339 verb's bulk
// operation with W610 liveness parity: 3 consecutive dead passes, extend
// lease honored, unknown never releases) over the loop's project, so stale
// claims return to READY without an operator pass and dispatch refills them
// same-cycle. Releases broadcast fleet-wide (the ONE coord broadcast, 24h
// note-dedupe). The caller fail-isolates the sweep (the wisdom-sweep rule).
// W1302.5: when a transport probe rides the deps, each pass first reads the
// buckle in-flight index — a claimant holding an ACTIVE gate request is
// producing, so its claim holds (O1 admission-misfire guard); an
// unavailable index leaves the pass transport-blind, never transport-dead.
import { projectIdentity } from "../govdb/govdb.ts";
import { reclaimAll } from "../lanes/reclaim-all.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import type { TransportProbe } from "../lanes/transport-liveness.ts";
import type { LoopDeps } from "./runtime.ts";

export function createReclaimSweep(
	deps: LoopDeps & {
		broadcast: (note: string) => unknown;
		store: () => GovernorStore;
		transport?: TransportProbe;
	},
): { reclaimSweep: () => Promise<void> } {
	const { REPO, log, broadcast, store, transport } = deps;
	return {
		reclaimSweep: async (): Promise<void> => {
			let inflight: Map<string, boolean> | null = null;
			if (transport) {
				try {
					const probe = await transport.probe();
					inflight = probe.available ? probe.alive : null;
				} catch {
					inflight = null;
				}
			}
			const r = reclaimAll(
				store(),
				projectIdentity(REPO),
				REPO,
				inflight ?? undefined,
			);
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
