// scripts/lib/plaid-launch.ts — W1102.1: the Plaid launch preflight, one
// call before each claim/take (1500-line law extraction from
// dispatch-next.ts). Assembles: the host-pressure hold (fail-closed —
// unknown samples pause, swapout deltas over raw totals, no numeric lane
// cap), the pool plan and the route pick. skip = hold/plan/denial reason.
import type { GovernorStore } from "../../hooks/lib/govdb.ts";
import type { ProviderPenalty } from "../../hooks/lib/exec-quota.ts";
import { plaidDispatch, plaidGate } from "../../hooks/lib/plaid.ts";
import { plaidLaunchHold } from "../../hooks/lib/plaid-host-pressure.ts";

export interface PlaidLaunchPreflight {
	/** non-null = SKIP dispatch with this reason. */
	skip: string | null;
	/** Spread into the execPick result when not skipped. */
	pick: Record<string, unknown>;
	/** The route this lane rides (the trace fact's value). */
	routeName: string | null;
	/** The loud admission NOTE body (caller prints with NOTE — prefix). */
	note: string | null;
}

export const plaidLaunchPreflight = async (o: {
	store: GovernorStore;
	sids: string[];
	quota: ProviderPenalty;
	ordinal: number;
	hub: string | null;
	routePin?: string;
	fleetDir: string;
	/** injected model-health map (tests); default null = run probe */
	modelHealth?: Map<string, string | null> | null;
}): Promise<PlaidLaunchPreflight> => {
	// 1. host pressure BEFORE any claim/take — fail-closed, no numeric cap
	const hold = plaidLaunchHold(o.fleetDir);
	if (hold) return { skip: hold, pick: {}, routeName: null, note: null };
	// 2. pool plan + route pick (the W911 override). modelHealth semantics
	//    pass through untouched: null = probe RAN, catalog unavailable →
	//    plaidDispatch holds fail-closed; undefined = no probe ran (operator
	//    --no-belt / --dry-run) → the explicit override stands.
	const pd = plaidDispatch({
		store: o.store,
		sids: o.sids,
		quota: o.quota,
		ordinal: o.ordinal,
		hub: o.hub,
		modelHealth: o.modelHealth,
		routePin: o.routePin,
	});
	if (pd.skip) return { skip: pd.skip, pick: {}, routeName: null, note: null };
	return {
		skip: null,
		pick: pd.pick as Record<string, unknown>,
		routeName: pd.routeName,
		note: pd.note,
	};
};

// plaidGate re-export kept for the dispatch-side board surface (the plan
// view reads the same gate the launch preflight ran).
export { plaidGate };
