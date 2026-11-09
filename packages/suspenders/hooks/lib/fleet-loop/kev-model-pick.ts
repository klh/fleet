// hooks/lib/fleet-loop/kev-model-pick.ts — W2677: kev-chooses for a bare
// `.prefer hub=<label>` lane. The static hubs.<label>.default_models chain
// (W2637) rendered a fixed "picked-by=.prefer line N" pin; the owner
// directive (2026-11-03) makes hub= mean KEV picks the model from that
// hub's LIVE offerings. Offerings = serving reality only (W2637): the
// resolved hub's own GET /v1/models catalog (the model-health face) —
// never a wire-dialect gate. kevTypedDecision gets one typed choice over
// the offerings (the caller names the work in `state` so the pick is per
// work type); ANY kev/catalog failure falls back deterministically and the
// static default_models chain stays the safety net (attempt walks it; the
// tail rides --fallback-model as usual). Unknown never blocks a launch
// (W1712/W576 parity) — the launched lane keeps the static pick.
import { kevTypedDecision } from "../knowledge/kev.ts";
import { type HubLocation, resolveHub } from "../hub/hub-locate.ts";
import { fetchHubCatalog } from "../hub/model-health.ts";
import { hubCredential } from "../lanes/lane-auth.ts";
import { tryLoadStack } from "../stack-config.ts";

/** One bounded catalog read per launch attempt (W779 parity — never a burst). */
export const KEV_MODEL_CATALOG_TIMEOUT_MS = 3000;
/** kev pick budget — latency-bound (this rides the launch path); kev-cold
 *  misses fall back deterministically (dispatch must not stall on kev). */
export const KEV_MODEL_DECISION_TIMEOUT_MS = 8000;
/** Offerings cap — the typed choice stays bounded on a wide catalog. */
export const KEV_MODEL_MAX_OPTIONS = 12;

/** A kev (or fallback) pick over one hub's live offerings. `model` is the
 *  EXACT served wire id (the catalog's own spelling — served-models grades
 *  it verbatim downstream; never an alias we minted). */
export type KevModelPick = {
	model: string;
	via: "kev" | "fallback";
	reason: string;
	/** The catalog the pick came from (excerpt) — brief + NOTE provenance. */
	offerings: string[];
};

/** The static default_models rung the launch composed (safety net). */
const staticRung = (hubPick: string, model: string | null): string | null => {
	if (!model) return null;
	const hit = Object.entries(tryLoadStack()?.hubs ?? {}).find(
		([label]) => label.toLowerCase() === hubPick.toLowerCase(),
	);
	return hit?.[1].default_models?.includes(model) ? model : null;
};

/** Offerings → the typed option set: catalog order, capped, deduped. */
export const kevModelOptions = (offerings: readonly string[]): string[] =>
	[...new Set(offerings)].slice(0, KEV_MODEL_MAX_OPTIONS);

export const kevModelPick = async (o: {
	/** The lane's hub label (.prefer hub= / policy hub / --hub). */
	hubPick: string;
	/** The hub's one-off candidate URLs (.prefer hub-url=). */
	hubUrls?: string[];
	/** The static model the launch composed (null = hub declares none). */
	model: string | null;
	/** Work-type context for kev (item id + title + tag classes). */
	state: string;
	env?: NodeJS.ProcessEnv;
	resolve?: (label: string, oneOff: string[]) => Promise<HubLocation | null>;
	catalogTimeoutMs?: number;
	decisionTimeoutMs?: number;
	/** W2860: plaid routes are an operator-deliberate pick (health/quota
	 *  placement, not a free choice) — the serving-reality check and
	 *  default_models fallback still apply, but kev is never asked to
	 *  override a route pin with a "better" model. */
	skipDecision?: boolean;
}): Promise<KevModelPick | null> => {
	const env = o.env ?? process.env;
	const resolve = o.resolve ?? resolveHub;
	// the pick rides ONE hub: an unresolvable label degrades to local belt,
	// whose ladder (not kev) owns routing — nothing to choose here
	const hub = await resolve(o.hubPick, o.hubUrls ?? []);
	if (!hub)
		return {
			model: o.model ?? "",
			via: "fallback",
			reason: `hub ${o.hubPick} unresolvable — rides local belt ladder, no kev pick`,
			offerings: [],
		};
	const key = hub.token ?? hubCredential(hub.label, env);
	const offerings = await fetchHubCatalog(
		hub.url,
		key,
		o.catalogTimeoutMs ?? KEV_MODEL_CATALOG_TIMEOUT_MS,
	);
	if (offerings === null)
		return {
			model: o.model ?? "",
			via: "fallback",
			reason: `hub ${hub.label} catalog unavailable — unknown never blocks; static pick stands`,
			offerings: [],
		};
	if (offerings.length === 0)
		return {
			model: o.model ?? "",
			via: "fallback",
			reason: `hub ${hub.label} serves an empty catalog — static pick stands`,
			offerings: [],
		};
	// W2860: a plaid route is a deliberate health/quota pick, not a free
	// choice — if the hub already serves it, it stands untouched; skip
	// straight past the kev-ask and the default_models fallback below.
	if (o.skipDecision && o.model && offerings.includes(o.model))
		return {
			model: o.model,
			via: "fallback",
			reason: `hub ${hub.label} serves the route's pinned model directly — stands`,
			offerings,
		};
	// deterministic fallback first (the numbers stay authoritative — kev only
	// breaks fuzzy ties, kev-placement law): the static rung when this hub
	// actually serves it, else the head of the live catalog.
	const rung = staticRung(o.hubPick, o.model);
	const options = kevModelOptions(offerings);
	const fallbackModel = rung && offerings.includes(rung) ? rung : options[0];
	const fallback = (): KevModelPick => ({
		model: fallbackModel ?? offerings[0] ?? "",
		via: "fallback",
		reason: rung
			? `hub ${hub.label} serves static default ${rung} — stands`
			: `hub ${hub.label} offerings — head ${fallbackModel} (catalog order)`,
		offerings,
	});
	if (o.skipDecision) return fallback();
	const d = await kevTypedDecision({
		state: `hub ${hub.label} live /v1/models offerings: ${options.join(", ")}\n${o.state}`,
		question:
			"Pick the model for this lane from the hub's live offerings. Match the work type: implementation lanes need strong code models, reviews/verifications need careful readers, cheap utility work may ride a fast tier. When unsure prefer the stronger model.",
		options: options.map((id) => ({ label: id })),
		timeoutMs: o.decisionTimeoutMs ?? KEV_MODEL_DECISION_TIMEOUT_MS,
	});
	if (!d) return fallback();
	const chosen = offerings.find((id) => id === d.choice);
	if (!chosen) return fallback();
	return {
		model: chosen,
		via: "kev",
		reason: `kev ${d.model} chose ${chosen} (${Math.round(d.confidence * 100)}%) from hub ${hub.label}'s ${String(offerings.length)} offerings`,
		offerings,
	};
};

/** The lane-brief disclosure (composeDispatchBrief extra): the operator sees
 *  WHY the lane rides this model — kev's pick, the hub, the offerings. */
export const kevModelBriefLines = (p: KevModelPick): string[] => [
	`ROUTING: hub picks by kev — model ${p.model} (${p.reason}; offerings: ${p.offerings.slice(0, 6).join(", ") || "unavailable"}${p.offerings.length > 6 ? ` …(+${String(p.offerings.length - 6)} more)` : ""}; safety net: hubs.<label>.default_models chain + --fallback-model)`,
];

/** Dispatch-output NOTE + audit line. */
export const kevModelNote = (item: string, p: KevModelPick): string =>
	`NOTE — kev-chooses ${item}: ${p.reason}`;

/** The execPick audit field (preference.audit — never a routing input). */
export const kevModelAudit = (p: KevModelPick): string =>
	`kev-chooses: ${p.model} (${p.via}) — ${p.reason}`;

/** A stub kev answer for the dispatch preview (admitModel not consulted on
 *  DRY): renders what the pick WOULD say without a live kev/catalog call. */
export const kevModelPreviewLine = (hubPick: string, model: string | null) =>
	`hub ${hubPick}: kev chooses from live offerings at launch (static safety net: ${model ?? "none"})`;
