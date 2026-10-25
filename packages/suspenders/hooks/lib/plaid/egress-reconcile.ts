// hooks/lib/plaid/egress-reconcile.ts — W1264.2: connection-count reconciliation
// between the tunnel's connection index (Sing /connections — W1260.1 owns
// the live producer) and the gateway's request index (Buckle — W1259 owns
// the live producer). Matching is STRICTLY by unique id (the gateway row's
// tunnelConnId vs the tunnel row's id): no host/time heuristics, no count
// equality, and a matched transport row NEVER promotes to request-aware —
// one tunnel connection can carry many requests (HTTP/2 multiplexing,
// keep-alive), which is exactly why counts are never equated.
import type { AgentType } from "../vendor/skills-agents.ts";
import {
	classifyVisibility,
	type EgressTrustSource,
	type VisibilityTier,
} from "./egress-visibility.ts";

/** One tunnel connection (Sing /connections row — W1260.1-shaped seam;
 * the live producer lives in the Sing lane, this is the read-model input). */
export interface TunnelConnection {
	id: string;
	/** Process attribution, when the tunnel observed one. */
	process: string | null;
	/** Destination host (SNI or resolved hostname). */
	host: string;
	port: number | null;
	/** Epoch ms, when known. */
	start: number | null;
	/** Catalog attribution when the row maps to a catalog target (W918), else null — never guessed. */
	agentType: AgentType | null;
}

/** One gateway request/connection row (Buckle index — W1259-shaped seam;
 * the live producer lives in the gateway lane, this is the read-model
 * input). */
export interface GatewayRequestRow {
	id: string;
	/** Correlation id: the tunnel connection this request rode, when it rode one. */
	tunnelConnId: string | null;
	/** Decoded request metadata (model, …) — present ONLY on genuinely
	 * request-aware rows, NEVER inferred from a CONNECT socket or an MCP call. */
	model: string | null;
	/** Epoch ms, when known. */
	start: number | null;
}

/** Per-source counts. NEVER assumed equal across sources — matchedTunnel
 * and matchedGateway differ under HTTP/2 multiplexing by design. */
export interface ReconciliationCounts {
	tunnel: number;
	gateway: number;
	/** Tunnel rows carrying at least one correlated gateway row. */
	matchedTunnel: number;
	/** Gateway rows correlated to a tunnel row. */
	matchedGateway: number;
	tunnelOnly: number;
	gatewayOnly: number;
}

export interface ConnectionReconciliation {
	/** One pair per correlated gateway row (many requests may ride one tunnel connection). */
	matched: Array<{ tunnelId: string; gatewayId: string }>;
	/** Tunnel rows with no gateway counterpart — transport-only observations. */
	tunnelOnly: TunnelConnection[];
	/** Gateway rows with no tunnel counterpart — e.g. routes that bypassed the tunnel. */
	gatewayOnly: GatewayRequestRow[];
	counts: ReconciliationCounts;
}

/** Reconcile the tunnel index against the gateway index by unique id ONLY.
 * No host/time heuristics: two rows that merely look alike stay unmatched —
 * a transport-tier row is never promoted into the request-aware count. */
export function reconcileConnections(
	tunnel: readonly TunnelConnection[],
	gateway: readonly GatewayRequestRow[],
): ConnectionReconciliation {
	const byTunnelId = new Map(tunnel.map((c) => [c.id, c]));
	const matchedTunnelIds = new Set<string>();
	const matchedGatewayIds = new Set<string>();
	const matched: Array<{ tunnelId: string; gatewayId: string }> = [];
	for (const row of gateway) {
		if (!row.tunnelConnId) continue;
		if (!byTunnelId.has(row.tunnelConnId)) continue;
		matched.push({ tunnelId: row.tunnelConnId, gatewayId: row.id });
		matchedTunnelIds.add(row.tunnelConnId);
		matchedGatewayIds.add(row.id);
	}
	const tunnelOnly = tunnel.filter((c) => !matchedTunnelIds.has(c.id));
	const gatewayOnly = gateway.filter((r) => !matchedGatewayIds.has(r.id));
	return {
		matched,
		tunnelOnly,
		gatewayOnly,
		counts: {
			tunnel: tunnel.length,
			gateway: gateway.length,
			matchedTunnel: matchedTunnelIds.size,
			matchedGateway: matchedGatewayIds.size,
			tunnelOnly: tunnelOnly.length,
			gatewayOnly: gatewayOnly.length,
		},
	};
}

/** Fold an (tunnel, gateway) index pair into coverage counts: per-tier
 * classification over the tunnel rows, plus the gateway's own requestAware
 * figure counted from ITS metadata — never inferred from the transport
 * observation, never equated with any tunnel count. */
export function summarizeReconciliation(
	tunnel: readonly TunnelConnection[],
	gateway: readonly GatewayRequestRow[],
	trust: EgressTrustSource,
): {
	tiers: Record<VisibilityTier, number>;
	requestAware: number;
} {
	const tiers: Record<VisibilityTier, number> = {
		request: 0,
		transport: 0,
		"pinning-fallback": 0,
		unattributed: 0,
	};
	for (const conn of tunnel) {
		const verdict = classifyVisibility(
			{ agentType: conn.agentType, destinationHost: conn.host },
			trust,
		);
		tiers[verdict.tier] += 1;
	}
	const requestAware = gateway.filter((r) => r.model !== null).length;
	return { tiers, requestAware };
}
