// hooks/lib/fleet-loop/kev-model.ts — W2593: the async half of the kev
// model sentinel. scripts/lib/kev-sentinel.ts classifies the .prefer chain
// into a plan (choose all/hub/glob · noop · misconfig); THIS module, wired
// into admitModel where async network work belongs, builds the candidate
// union the plan allows, asks the local kev (:8912, kevTypedDecision) to
// pick, and falls back deterministically (first candidate — catalog order)
// when kev is down or answers outside the set. Candidate union: the local
// buckle front's /v1/models plus, for scope "all", every known hub's —
// one bounded read each (W779: never a burst).
import { kevTypedDecision } from "../knowledge/kev.ts";
import { fetchHubCatalog } from "../hub/model-health.ts";
import { adminKey, hubCredential } from "../lanes/lane-auth.ts";
import { BUCKLE_SPOKE_PORT, loopbackUrl } from "../loopback.ts";
import type { KevPlan } from "../../../scripts/lib/kev-sentinel.ts";
import {
	globFilter,
	type KevPlanChoose,
} from "../../../scripts/lib/kev-sentinel.ts";
import {
	type HubLocation,
	knownHubLabels,
	resolveHub,
} from "../hub/hub-locate.ts";

export type KevModelGate =
	| { verdict: "skip"; note: string }
	| { verdict: "wait"; reason: string }
	| { verdict: "refused"; why: string }
	| {
			verdict: "model";
			model: string;
			via: "kev" | "deterministic";
			note: string;
	  };

/** The belt front the dispatch process itself rides. */
const beltFront = (env: NodeJS.ProcessEnv): string =>
	env.SUSPENDERS_BUCKLE_FRONT ?? loopbackUrl(BUCKLE_SPOKE_PORT);

/** One hub label's catalog with its own credential; null on any miss. */
const hubCatalog = async (
	label: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	resolve: (l: string, oneOff: string[]) => Promise<HubLocation | null>,
): Promise<{ label: string; models: string[] } | null> => {
	const loc = await resolve(label, []);
	if (!loc) return null;
	const key = loc.token ?? hubCredential(loc.label, env);
	const models = await fetchHubCatalog(loc.url, key, timeoutMs);
	return models === null ? null : { label: loc.label, models };
};

/** The candidate union the plan's scope allows, catalog order kept. */
export const kevCandidates = async (o: {
	plan: KevPlanChoose;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	resolve?: (l: string, oneOff: string[]) => Promise<HubLocation | null>;
}): Promise<string[]> => {
	const env = o.env ?? process.env;
	const timeoutMs = o.timeoutMs ?? 3000;
	const resolve = o.resolve ?? resolveHub;
	// scope "hub": the pinned hub's OWN catalog (rule 2); an unresolvable
	// hub degrades to the local belt front — the destination parity law
	// (served-models precedent): validate where the lane actually rides.
	let models: string[];
	if (o.plan.scope === "hub" && o.plan.hub) {
		const hub = await hubCatalog(o.plan.hub, env, timeoutMs, resolve);
		models = hub?.models ?? [];
	} else if (o.plan.scope === "hub") {
		const local = await fetchHubCatalog(
			beltFront(env),
			adminKey(env),
			timeoutMs,
		);
		models = local ?? [];
	} else {
		const local = await fetchHubCatalog(
			beltFront(env),
			adminKey(env),
			timeoutMs,
		);
		models = local ?? [];
	}
	if (o.plan.scope !== "all") return globFilter(models, o.plan.prefixes);
	// scope "all": union the local front with every known hub, deduped
	// first-seen (local first — it is what the lane would ride by default)
	const seen = new Set(models);
	for (const label of knownHubLabels()) {
		if (label.toLowerCase() === "local") continue;
		const hub = await hubCatalog(label, env, timeoutMs, resolve);
		if (!hub) continue;
		for (const m of hub.models) seen.add(m);
	}
	return globFilter([...seen], o.plan.prefixes);
};

/** The launch-time gate: plan → candidates → kev pick (deterministic
 *  fallback). Runs BEFORE every other admission gate — the model it sets
 *  is what pools/wire/served validate. `decide` is injected for tests. */
export const kevModelGate = async (o: {
	plan: KevPlan;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	resolve?: (l: string, oneOff: string[]) => Promise<HubLocation | null>;
	decide?: typeof kevTypedDecision;
}): Promise<KevModelGate> => {
	if (o.plan.kind === "noop")
		return { verdict: "skip", note: `kev sentinel: ${o.plan.reason}` };
	if (o.plan.kind === "misconfig")
		return { verdict: "refused", why: `kev sentinel: ${o.plan.why}` };
	const decide = o.decide ?? kevTypedDecision;
	const candidates = await kevCandidates({
		plan: o.plan,
		env: o.env,
		timeoutMs: o.timeoutMs,
		resolve: o.resolve,
	});
	if (candidates.length === 0) {
		const scope =
			o.plan.scope === "all"
				? "all hubs"
				: `hub ${o.plan.hub ?? "(local belt)"}`;
		return {
			verdict: "wait",
			reason: `kev sentinel: no candidate models in ${scope}${o.plan.prefixes.length ? ` matching ${o.plan.prefixes.join(", ")}*` : ""} — catalogs unreadable or empty; retry next cycle`,
		};
	}
	const d = await decide({
		state: `available models (${String(candidates.length)}): ${candidates.slice(0, 40).join(", ")}`,
		question:
			"Pick the model for the next fleet lane. Prefer capable general models over narrow ones.",
		options: candidates.map((m) => ({ label: m })),
		...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
	});
	if (d && candidates.includes(d.choice))
		return {
			verdict: "model",
			model: d.choice,
			via: "kev",
			note: `kev ${d.model} chose ${d.choice} (${Math.round(d.confidence * 100)}%) of ${String(candidates.length)} candidates`,
		};
	const first = candidates[0] as string;
	return {
		verdict: "model",
		model: first,
		via: "deterministic",
		note: `kev unavailable/out-of-set — deterministic first candidate ${first}`,
	};
};
