// deploy/singbox/egress.ts — W1264.1: the AI-egress coverage model for the
// Windows TUN capture. Boundaries (owner corrections 2026-10-24, facts
// finding.full-machine-ai-egress-design-20261024 +
// finding.vercel-skills-detection-install-boundary-20261024):
//   - tool detection rides the ONE catalog (hooks/lib/install/targets.ts on the
//     vendored vercel-labs/skills registry) — no parallel AI CLI scanner;
//   - app-native Buckle base config is preserved where supported: a
//     buckleCompatible catalog target keeps its own base URL and its LAN
//     traffic rides the private→direct rule, never re-steered through the
//     relay (W1265 installs the named routes /zai/anthropic, /zai/openai
//     with installer-visible base URLs);
//   - TUN = transport coverage for what cannot set a base (GUI apps);
//     Sing process observation may identify GUI apps but claims NO catalog
//     tool-install support;
//   - Buckle CONNECT is L4: the encrypted request wire/model stays
//     invisible to the gateway — no inspection claims anywhere.
import type {
	FleetCapabilities,
	FleetTarget,
} from "../../hooks/lib/install/targets.ts";
import { capabilityCatalog } from "../../hooks/lib/install/targets.ts";

/** The hub-bound outbound tag the fleet law names (same tag as the Mac
 *  module's template — one vocabulary at merge). */
export const HUB_TAG = "hub-relay";

/** AI provider domain suffixes the TUN capture steers to the hub relay
 *  (sing-box `domain_suffix` matches the bare domain too). Curated to the
 *  providers this stack actually rides; extend HERE, one source of truth. */
export const AI_EGRESS_DOMAINS: readonly string[] = [
	// Anthropic / Claude
	"anthropic.com",
	"claude.ai",
	// OpenAI / ChatGPT
	"openai.com",
	"chatgpt.com",
	"oaistatic.com",
	"oaiusercontent.com",
	// Z.ai (GLM) — named buckle routes /zai/anthropic, /zai/openai (W1265)
	"api.z.ai",
	// GitHub Copilot seat (W695.6)
	"githubcopilot.com",
	// Gemini CLI (catalog target gemini-cli)
	"generativelanguage.googleapis.com",
	// Grok (wired dialect)
	"x.ai",
	"grok.com",
];

/** GUI AI apps the TUN capture covers BY PROCESS — they cannot take a
 *  Buckle base URL, so transport is the only coverage path. Observation and
 *  coverage only: these are NOT catalog tools and get NO install claims
 *  (owner boundary). Image names (task-manager names) on Windows. */
export interface EgressGuiApp {
	/** Windows process/image name sing-box `process_name` matches. */
	name: string;
	/** Human label. */
	app: string;
}

export const GUI_AI_APPS: readonly EgressGuiApp[] = [
	{ name: "ChatGPT.exe", app: "ChatGPT desktop" },
	{ name: "claude.exe", app: "Claude desktop" },
];

/** Buckle-route adapter metadata atop the catalog capability model (owner
 *  correction): convention only — W1265 installs the actual route table and
 *  the installer-visible tool config base URLs. */
export const BUCKLE_ROUTE_META = {
	convention: "/<provider>/<protocol>",
	examples: ["/zai/anthropic", "/zai/openai"],
	source: "W1265",
} as const;

/** How a detected tool's AI traffic is covered. */
export type EgressMode =
	| "app-native"
	| "tun-domain-coverage"
	| "tun-process-coverage"
	| "undetected";

/** One catalog row in egress terms. */
export interface EgressTarget {
	type: string;
	displayName: string;
	installed: boolean;
	egressMode: EgressMode;
	buckleRoute: string | null;
}

export interface EgressPlan {
	targets: EgressTarget[];
	guiApps: Array<{ name: string; app: string; coverage: "tun" }>;
	domains: readonly string[];
	routes: typeof BUCKLE_ROUTE_META;
}

/** Egress mode from the catalog capability row (targets.ts):
 *  buckleCompatible=true rides its app-native base config; false and the
 *  unaudited "unknown" get TUN coverage — transport truth, not a capability
 *  claim. Never a catalog install claim. */
export const egressModeFor = (
	buckleCompatible: boolean | "unknown",
	installed: boolean,
): EgressMode => {
	if (!installed) return "undetected";
	if (buckleCompatible === true) return "app-native";
	return "tun-domain-coverage";
};

/** The sing-box route rules the Windows TUN capture enforces, in match
 *  order (dns → sniff → private→direct → GUI process → AI domains). One
 *  source of truth; windows.ts render() injects them into the template's
 *  empty rules array. process_name matches image names only — catalog CLIs
 *  never get process rules (the catalog/config boundary, owner correction). */
export function singboxEgressRules(): unknown[] {
	return [
		{ protocol: "dns", action: "hijack-dns" },
		{ inbound: "tun-in", action: "sniff" },
		{ ip_is_private: true, outbound: "direct" },
		...GUI_AI_APPS.map((g) => ({
			process_name: [g.name],
			outbound: HUB_TAG,
		})),
		{ domain_suffix: [...AI_EGRESS_DOMAINS], outbound: HUB_TAG },
	];
}

type CatalogRow = FleetTarget & { capabilities: FleetCapabilities };

/** Injectable catalog reader (tests pass a fake; prod passes nothing). */
export type EgressDetect = (repoRoot: string) => Promise<CatalogRow[]>;

/** Build the plan from the real catalog (config-over-code: detection is the
 *  vendored registry — never a parallel scanner). */
export async function buildEgressPlan(
	repoRoot: string,
	detect: EgressDetect = capabilityCatalog,
): Promise<EgressPlan> {
	const rows = await detect(repoRoot);
	return {
		targets: rows.map((row) => ({
			type: row.type,
			displayName: row.displayName,
			installed: row.installed,
			egressMode: egressModeFor(
				row.capabilities.buckleCompatible,
				row.installed,
			),
			// named-route VALUES land with W1265's route table
			buckleRoute: null,
		})),
		guiApps: GUI_AI_APPS.map((g) => ({ ...g, coverage: "tun" as const })),
		domains: AI_EGRESS_DOMAINS,
		routes: BUCKLE_ROUTE_META,
	};
}
