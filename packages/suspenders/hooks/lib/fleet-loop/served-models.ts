// hooks/lib/fleet-loop/served-models.ts — W2572: dispatch-time served-model
// validation. The dispatch table can print a doomed pick (executor + model +
// hub) and spawn anyway — the lane then 503-loops dead because nothing
// validated that the DESTINATION actually serves the composed model (owner
// incident 2026-11-02, tredebanken W1.1: copilot + glm pin on a hub that
// serves none of the glm family, 503 x5 in 19s). This gate resolves the
// lane's real destination — hub= lanes: the hub's buckle catalog; belt-direct
// lanes: the local spoke/belt front — reads its served model list
// (GET /v1/models, the model-health catalog face), and refuses the launch
// BEFORE the claim. Client-agnostic by construction: the COMPOSED MODEL is
// validated, never the client (claude/codex/copilot ride the same check).
// The served list is ground truth; SUSPENDERS_MODEL_HEALTH=0 (the stale
// health-FACT repin bypass) does NOT bypass this gate. Unknown — catalog
// unreadable, no credential, timeout, or an empty registry hub degrading to
// local belt — never refuses (missing evidence never blocks, W1712/W576).
import { wireModelMatch } from "../gates/wire-model-check.ts";
import { type HubLocation, resolveHub } from "../hub/hub-locate.ts";
import { fetchHubCatalog } from "../hub/model-health.ts";
import { adminKey, hubCredential } from "../lanes/lane-auth.ts";
import { BUCKLE_SPOKE_PORT, loopbackUrl } from "../loopback.ts";

/** One bounded catalog read per launch attempt (never a burst, W779). */
export const SERVED_MODELS_TIMEOUT_MS = 3000;
/** Refusal excerpts stay paste-able — the head of the list, not all of it. */
export const SERVED_MODELS_EXCERPT = 8;

export type ServedModelsGate =
	| { verdict: "pass"; destination: string; url: string; servedBy: string }
	| { verdict: "refused"; why: string }
	| { verdict: "unknown"; note: string };

/** Pure verdict: does the destination's served list carry the model class?
 *  The W1302.6 class matcher folds routing prefixes (`zai-glm-5.3-flash`
 *  serves `glm-5.3-flash`) — the one comparison law, never re-derived. */
export const servedModelsVerdict = (
	model: string,
	served: readonly string[],
): { ok: true; servedBy: string } | { ok: false; why: string } => {
	const hit = served.find((id) => wireModelMatch(model, id) === "match");
	if (hit !== undefined) return { ok: true, servedBy: hit };
	const shown = served.slice(0, SERVED_MODELS_EXCERPT).join(", ");
	const more =
		served.length > SERVED_MODELS_EXCERPT
			? ` …(+${served.length - SERVED_MODELS_EXCERPT} more)`
			: "";
	return {
		ok: false,
		why: `served: ${shown || "(empty list)"}${more}`,
	};
};

/** The launch-time gate over one composed model + destination label.
 *  `resolve` is injected for tests only — production walks the real
 *  hub-locate chain (env override → one-offs → stack → registry → mDNS). */
export const servedModelsGate = async (o: {
	model: string;
	hubPick: string | null;
	hubUrls: string[];
	noBelt?: boolean;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	resolve?: (label: string, oneOff: string[]) => Promise<HubLocation | null>;
}): Promise<ServedModelsGate> => {
	if (o.noBelt)
		return {
			verdict: "unknown",
			note: "no-belt lane speaks its own API — no served list to validate",
		};
	const env = o.env ?? process.env;
	const timeoutMs = o.timeoutMs ?? SERVED_MODELS_TIMEOUT_MS;
	const resolve = o.resolve ?? resolveHub;
	const beltUrl = env.SUSPENDERS_BUCKLE_FRONT ?? loopbackUrl(BUCKLE_SPOKE_PORT);
	// Destination parity with the launch path (lane-launch hubPick chain):
	// a hub that resolves wins; a dark/unreachable label degrades to the
	// local belt — which is then the list the lane actually rides.
	let url = beltUrl;
	let key: string | null = adminKey(env);
	let destination = "belt front";
	if (o.hubPick) {
		const hub = await resolve(o.hubPick, o.hubUrls);
		if (hub) {
			url = hub.url;
			key = hub.token ?? hubCredential(hub.label, env);
			destination = `hub ${hub.label}`;
		}
	}
	const served = await fetchHubCatalog(url, key, timeoutMs);
	if (served === null)
		return {
			verdict: "unknown",
			note: `${destination} ${url} catalog unavailable — model ${o.model} unverified, launch proceeds`,
		};
	const v = servedModelsVerdict(o.model, served);
	if (v.ok) return { verdict: "pass", destination, url, servedBy: v.servedBy };
	return {
		verdict: "refused",
		why: `${destination} ${url} does not serve ${o.model} (${v.why})`,
	};
};
