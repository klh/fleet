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
import { type HubSurvey, surveyHubCatalogs } from "./kev-hub-survey.ts";

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
	/** W2777: the hub the pick rides (undefined = no hub — local belt). */
	hub?: string;
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
			hub: hub.label,
		};
	if (offerings.length === 0)
		return {
			model: o.model ?? "",
			via: "fallback",
			reason: `hub ${hub.label} serves an empty catalog — static pick stands`,
			offerings: [],
			hub: hub.label,
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
		hub: hub.label,
	});
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

/** A kev (model, hub) pair option — the all-hubs pick unit (W2777). The
 *  same model on two hubs is TWO options: load decides, never catalog
 *  order alone. */
export type KevPairOption = { model: string; hub: string };

export const kevPairKey = (p: KevPairOption): string => `${p.model}@${p.hub}`;

/** Live surveys → the pair option set: down hubs (null catalog) drop
 *  entirely; models penalized by a load signal (health-down core, active
 *  rate-limit/quota cooling) are excluded pairs. Catalog order kept, cap
 *  KEV_MODEL_MAX_OPTIONS — kev's typed choice stays bounded. */
export const kevPairOptions = (
	surveys: readonly HubSurvey[],
	penalized: (model: string) => boolean = () => false,
): { options: KevPairOption[]; excluded: number } => {
	const options: KevPairOption[] = [];
	let excluded = 0;
	for (const s of surveys) {
		if (!s.offerings || s.offerings.length === 0) continue;
		for (const model of s.offerings) {
			if (penalized(model)) {
				excluded++;
				continue;
			}
			options.push({ model, hub: s.label });
		}
	}
	return { options: options.slice(0, KEV_MODEL_MAX_OPTIONS), excluded };
};

/** kev's per-hub load summary: `label (latms, n models)` rows, fastest
 *  first — the load evidence kev reasons over. */
export const kevPairLoadSummary = (surveys: readonly HubSurvey[]): string => {
	const live = surveys.filter((s) => s.offerings !== null);
	return live
		.sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))
		.map(
			(s) =>
				`${s.label} (${String(s.latencyMs ?? "?")}ms, ${String(s.offerings?.length ?? 0)} models)`,
		)
		.join("; ");
};

/** kev's pair-answer parser: `model@hub` back to the pair, validated
 *  against the option set (kev hallucination never routes). */
export const kevPairParse = (
	label: string,
	options: readonly KevPairOption[],
): KevPairOption | null => {
	const at = label.lastIndexOf("@");
	if (at <= 0) return null;
	const model = label.slice(0, at);
	const hub = label.slice(at + 1);
	return options.some((p) => p.model === model && p.hub === hub)
		? { model, hub }
		: null;
};

/** The deterministic pair fallback: the static default on the FASTEST
 *  live hub serving it, else the fastest live hub's catalog head. */
export const kevPairFallback = (
	surveys: readonly HubSurvey[],
	staticModel: string | null,
): KevModelPick | null => {
	const fast = surveys
		.filter((s) => s.offerings !== null)
		.sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9));
	const pick = fast[0];
	if (!pick) return null;
	const staticServing =
		staticModel === null
			? undefined
			: fast.find((s) => s.offerings?.includes(staticModel));
	if (staticServing)
		return {
			model: staticModel,
			via: "fallback",
			hub: staticServing.label,
			reason: `static default ${staticModel} stands on fastest serving hub ${staticServing.label} (${String(staticServing.latencyMs ?? "?")}ms)`,
			offerings: staticServing.offerings ?? [],
		};
	return {
		model: pick.offerings?.[0] ?? "",
		via: "fallback",
		hub: pick.label,
		reason: `fastest live hub ${pick.label} (${String(pick.latencyMs ?? "?")}ms) — head ${String(pick.offerings?.[0] ?? "")}`,
		offerings: pick.offerings ?? [],
	};
};

/** The all-hubs kev-chooses (W2777): survey every machine-conf hub, weigh
 *  the (model, hub) pair under per-hub load + work state, let kev pick
 *  ONE pair. No live pair → the static pick stands, hub undefined (the
 *  lane keeps local-belt routing); unknown never blocks (W1712/W576). */
export const kevPairPick = async (o: {
	state: string;
	model: string | null;
	penalized?: (model: string) => boolean;
	env?: NodeJS.ProcessEnv;
	survey?: () => Promise<HubSurvey[]>;
	decisionTimeoutMs?: number;
}): Promise<KevModelPick> => {
	const surveys = await (
		o.survey ?? (() => surveyHubCatalogs({ env: o.env }))
	)();
	const { options, excluded } = kevPairOptions(surveys, o.penalized);
	if (options.length === 0)
		return {
			model: o.model ?? "",
			via: "fallback",
			reason:
				excluded > 0
					? `all ${String(excluded)} live hub offerings are rate-limited or health-down — static pick stands`
					: "no hub serves a live catalog — rides the static pick / local belt ladder, no kev pick",
			offerings: [],
		};
	const labels = options.map(kevPairKey);
	const d = await kevTypedDecision({
		state: `live hub catalogs by load (fastest first): ${kevPairLoadSummary(surveys)}\npair options: ${labels.join(", ")}\n${o.state}`,
		question:
			"Pick the (model, hub) pair for this lane. Options are model@hub. Weigh the work type AND hub load: prefer a fast, healthy hub; a slower hub is fine when it serves the clearly better model for the work. Implementation lanes need strong code models, reviews/verifications need careful readers, cheap utility work may ride a fast tier. When unsure prefer the stronger model.",
		options: labels.map((label) => ({ label })),
		timeoutMs: o.decisionTimeoutMs ?? KEV_MODEL_DECISION_TIMEOUT_MS,
	});
	const chosen = d ? kevPairParse(d.choice, options) : null;
	if (d && chosen)
		return {
			model: chosen.model,
			via: "kev",
			hub: chosen.hub,
			reason: `kev ${d.model} chose ${chosen.model}@${chosen.hub} (${Math.round(d.confidence * 100)}%) across ${String(labels.length)} pair options`,
			offerings: surveys.find((s) => s.label === chosen.hub)?.offerings ?? [],
		};
	return (
		kevPairFallback(surveys, o.model) ?? {
			model: o.model ?? "",
			via: "fallback",
			reason: "live pair set vanished mid-pick — static pick stands",
			offerings: [],
		}
	);
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
