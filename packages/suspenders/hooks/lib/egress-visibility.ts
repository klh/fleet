// hooks/lib/egress-visibility.ts — W1264.2: selective request visibility
// for AI egress. Two laws bind this module:
// 1. Owner boundary (finding.vercel-skills-detection-install-boundary-20261024):
//    cross-tool detection and installation ride the vendored skills catalog
//    and its capability model (hooks/lib/targets.ts + fleet-install.ts).
//    This file adds ONLY Buckle-route configuration adapter metadata ATOP
//    that model — no scanner, no installer, no duplicated target list.
// 2. Never equate CONNECT to L7 API calls (W1264): a transport-tier row is
//    transport only. The `request` tier requires a verified Buckle route,
//    operator-deployed trust, AND an unpinned destination.
import { agents, type AgentType } from "./vendor/skills-agents.ts";
import { VERIFIED_BUCKLE_ROUTES } from "./targets.ts";

/** How much of a connection this fleet can honestly see. */
export type VisibilityTier =
	| "request" // decrypted, request-aware observation at the trusted Buckle route
	| "transport" // opaque TLS through the tunnel: addresses + byte counts only
	| "pinning-fallback" // would-be request row; destination pins certificates → transport-tier observation, TLS left end-to-end
	| "unattributed"; // seen at the tunnel; no catalog/process attribution — never guessed

/** The evidence the tier decision consumes. The live source is the W918
 * capability catalog (targets.ts) plus operator config-over-code trust;
 * tests stub it. */
export interface EgressTrustSource {
	/** Catalog targets with a VERIFIED buckle front route (targets.ts BUCKLE_ROUTE === true). */
	verifiedRoutes: ReadonlySet<AgentType>;
	/** Operator trust: apps whose request-aware route config is deployed (config-over-code). */
	trustedApps: ReadonlySet<AgentType>;
	/** Documented request capability (owner-verified research 2026-10-24):
	 * targets whose docs support pointing the model API URL at Buckle.
	 * Absent = transport-proxy/MCP-connector routes only — rows stay
	 * transport FOREVER, never request, regardless of trust. */
	requestCapableApps: ReadonlySet<AgentType>;
	/** Destination host suffixes that pin certificates — never inspected, always fallback. */
	pinnedDestinations: readonly string[];
}

/** Owner-verified research (2026-10-24): targets whose DOCUMENTED surface
 * can point the model API URL at Buckle — request-capable. Native ChatGPT
 * and Claude chat apps document only transport-proxy / MCP-connector
 * routes, so their egress stays transport-tier FOREVER. Codex model
 * sampling may ride wss://chatgpt.com; ChatGPT/desktop TLS inspection may
 * face pinning. Capability ≠ trust ≠ a verified route — three distinct
 * gates, never merged. */
export const REQUEST_CAPABLE_APPS: ReadonlySet<AgentType> = new Set([
	"claude-code",
	"codex",
	"grok",
	"github-copilot",
] as const satisfies AgentType[]);

/** Fleet default: W918 catalog evidence with EMPTY operator sets. Honest
 * default — until config-over-code deploys trust and pinning data, nothing
 * claims request-aware visibility it cannot prove. */
export const DEFAULT_EGRESS_TRUST: EgressTrustSource = {
	verifiedRoutes: VERIFIED_BUCKLE_ROUTES,
	requestCapableApps: REQUEST_CAPABLE_APPS,
	trustedApps: new Set<AgentType>(),
	pinnedDestinations: [],
};

/** Buckle-route configuration adapter metadata for one catalog target —
 * the ONLY layer this module adds atop the W918 capability catalog. The
 * catalog flags stay distinct (detected / skillInstallable / hookWired /
 * headless / resumable / buckleCompatible); this view derives from two of
 * them plus operator trust and never conflates them. */
export interface BuckleRouteAdapterMeta {
	type: AgentType;
	/** Documented endpoint-override capability (REQUEST_CAPABLE_APPS). */
	requestCapable: boolean;
	/** The target rides a verified buckle front route (targets.ts evidence). */
	routeVerified: boolean;
	/** Operator trust deployed for request-aware handling (config-over-code). */
	trusted: boolean;
	/** TRUE only when ALL hold; the classifier still refuses `request` on a pinned destination. */
	requestEligible: boolean;
}

/** Adapter metadata across the full catalog breadth — gated, not trimmed,
 * so unaudited targets stay visible for future adapters (targets.ts pattern). */
export function buckleRouteAdapters(
	trust: EgressTrustSource,
): BuckleRouteAdapterMeta[] {
	return (Object.keys(agents) as AgentType[])
		.filter((type) => type !== "universal") // not a real install target
		.map((type) => {
			const requestCapable = trust.requestCapableApps.has(type);
			const routeVerified = trust.verifiedRoutes.has(type);
			const trusted = trust.trustedApps.has(type);
			return {
				type,
				requestCapable,
				routeVerified,
				trusted,
				requestEligible: requestCapable && routeVerified && trusted,
			};
		});
}

/** Suffix match on the destination host: exact or subdomain — `api.x.pin`
 * matches suffix `x.pin`; `notx.pin` does NOT (label boundary, not substring). */
export function hostMatchesSuffix(
	host: string,
	suffixes: readonly string[],
): boolean {
	const h = host.trim().toLowerCase();
	return suffixes.some((s) => {
		const suffix = s.trim().toLowerCase();
		return h === suffix || h.endsWith(`.${suffix}`);
	});
}

/** One observed connection to classify. */
export interface VisibilityInput {
	/** Catalog/process attribution, when the tunnel row maps to a catalog target; null when none. */
	agentType: AgentType | null;
	/** Destination host (resolved address hostname or TLS SNI). */
	destinationHost: string;
}

/** The honest verdict for one connection. */
export interface VisibilityVerdict {
	tier: VisibilityTier;
	/** Always set — non-request rows carry WHY they are not request rows. */
	reason: string;
	/** TRUE only for tier "request" — the one flag coverage may sum as API calls. */
	requestAware: boolean;
}

/** Classify one connection into its honest visibility tier.
 * Order matters: attribution first (nothing is guessed for unattributed
 * rows), then the request gate (verified route AND operator trust), then
 * the pinning fallback, and only then `request`. */
export function classifyVisibility(
	input: VisibilityInput,
	trust: EgressTrustSource = DEFAULT_EGRESS_TRUST,
): VisibilityVerdict {
	if (!input.agentType) {
		return {
			tier: "unattributed",
			reason: "tunnel observation with no catalog/process attribution",
			requestAware: false,
		};
	}
	if (!trust.requestCapableApps.has(input.agentType)) {
		return {
			tier: "transport",
			reason:
				"no documented request capability — transport-proxy/MCP-connector routes only",
			requestAware: false,
		};
	}
	const routeVerified = trust.verifiedRoutes.has(input.agentType);
	const trusted = trust.trustedApps.has(input.agentType);
	if (!routeVerified || !trusted) {
		return {
			tier: "transport",
			reason: routeVerified
				? "verified route but operator trust not deployed"
				: trusted
					? "operator trust deployed but no verified buckle route"
					: "no verified route and no operator trust",
			requestAware: false,
		};
	}
	if (hostMatchesSuffix(input.destinationHost, trust.pinnedDestinations)) {
		return {
			tier: "pinning-fallback",
			reason:
				"destination pins certificates — TLS left end-to-end, transport-tier observation only",
			requestAware: false,
		};
	}
	return {
		tier: "request",
		reason: "trusted app on a verified buckle route, unpinned destination",
		requestAware: true,
	};
}

/** Coverage summary across observed rows: per-tier counts plus the one
 * honest API-call figure — requestAware — and its complement. Transport
 * and unattributed rows NEVER fold into it. */
export function summarizeVisibility(
	rows: ReadonlyArray<{ host: string; agentType: AgentType | null }>,
	trust: EgressTrustSource = DEFAULT_EGRESS_TRUST,
): {
	requestAware: number;
	tiers: Record<VisibilityTier, number>;
} {
	const tiers: Record<VisibilityTier, number> = {
		request: 0,
		transport: 0,
		"pinning-fallback": 0,
		unattributed: 0,
	};
	let requestAware = 0;
	for (const row of rows) {
		const verdict = classifyVisibility(
			{ agentType: row.agentType, destinationHost: row.host },
			trust,
		);
		tiers[verdict.tier] += 1;
		if (verdict.requestAware) requestAware += 1;
	}
	return { requestAware, tiers };
}
