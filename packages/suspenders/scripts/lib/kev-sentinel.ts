// scripts/lib/kev-sentinel.ts — W2593: `kev` as a MODEL value (owner spec
// 2026-11-03). When the model the lane would ride is set to kev — the
// .prefer model= pin, a must=/prefer= directive token, or the machine-conf
// executors row default — the locally running kev (:8912) picks the real
// model from the candidates the rule for that configuration allows. This
// module is the PURE grammar half: it reads a resolved .prefer chain and
// stamps the pick with the kev plan (choose/no-op/misconfig); the async
// half (candidate union + the :8912 call) is kev-model.ts, wired into the
// launch admission path where async network work belongs.
//
// Rules (owner spec, verbatim semantics):
//  1. no MUST/PREFER/HUB directives, model=kev (or conf kev default) →
//     kev chooses from ALL models available anywhere in the fleet of hubs.
//  2. hub= present → kev decides among that hub's models only.
//  3. hub + prefer=partial-model-* → kev decides within the glob list.
//  4. hub + prefer=full-model-name → ALWAYS that model; kev nonfunctional.
//  5. hub + must=partial* → kev chooses from the glob list.
//  6. hub + must=fullmodel OR multiple must directives → does nothing.
//  7. hub + must AND prefer together → misconfiguration (they cannot
//     coexist); the launch refuses loudly instead of guessing an order.
//  8. hub + must AND can → can is a development override, in reality a
//     must override — same as rule 6: does nothing.
//
// "Does nothing" (noop) means the kev token never reaches the CLI: today's
// behavior stands for everything EXCEPT the pick's model pin — a kev
// token still riding it would 400 client-side, so noop drops the pin back
// to the model= / conf layer.
import type { PreferChain } from "./exec-chain.ts";

/** The one configured hub, plus that hub's own declared URLs. */
export interface KevChainView {
	hub: string | null;
	hubUrls: string[];
	directives: { value: string; kind: "must" | "prefer" | "can" }[];
	/** nearest-file can= (W1470) — presence is all rule 8 reads. */
	can: { value: string } | null;
}

/** View over preferOf()'s chain — everything rule classification reads. */
export const kevChainView = (c: PreferChain): KevChainView => ({
	hub: c.hub,
	hubUrls: c.hubUrls,
	directives: c.directives.map((d) => ({ value: d.value, kind: d.kind })),
	can: c.can ? { value: c.can.value } : null,
});

/** Partial-model token: trailing `*` with a non-empty prefix (`glm-*`).
 * A bare `*` is ALL — not one model's glob — so it is not partial. */
export const isModelGlob = (token: string): boolean =>
	token.length > 1 && token.endsWith("*") && !token.slice(0, -1).includes("*");

export type KevPlanChoose = {
	kind: "choose";
	/** "all" = every hub's models; "hub" = the pinned hub's models only. */
	scope: "all" | "hub";
	hub: string | null;
	/** glob prefixes (empty = no glob, all candidates). */
	prefixes: string[];
};

export type KevPlan =
	| KevPlanChoose
	| { kind: "noop"; reason: string }
	| { kind: "misconfig"; why: string };

/** Classify one resolved chain into the kev plan (rules 1–8). */
export const kevPlanOf = (c: KevChainView): KevPlan => {
	const musts = c.directives.filter((d) => d.kind === "must");
	const prefers = c.directives.filter((d) => d.kind === "prefer");
	if (musts.length > 0 && prefers.length > 0)
		return {
			kind: "misconfig",
			why: "must= and prefer= cannot coexist — kev refuses to guess an order",
		};
	if (musts.length > 1)
		return {
			kind: "noop",
			reason: "multiple must= directives — kev does nothing",
		};
	const canActive = c.can !== null;
	if (musts.length === 1) {
		// rule 8 folds into 6: can= is in reality a must override, so the
		// pair does nothing — whatever can= would pick is not kev's call.
		if (canActive)
			return {
				kind: "noop",
				reason: `must= + can= — can is in reality a must override, kev does nothing`,
			};
		const tok = musts[0]?.value ?? "";
		if (isModelGlob(tok))
			return {
				kind: "choose",
				scope: c.hub ? "hub" : "all",
				hub: c.hub,
				prefixes: [tok.slice(0, -1)],
			};
		return { kind: "noop", reason: `must=${tok} is a full model — kev does nothing` };
	}
	if (prefers.length === 1) {
		const tok = prefers[0]?.value ?? "";
		if (isModelGlob(tok))
			return {
				kind: "choose",
				scope: c.hub ? "hub" : "all",
				hub: c.hub,
				prefixes: [tok.slice(0, -1)],
			};
		return { kind: "noop", reason: `prefer=${tok} is a full model — kev does nothing` };
	}
	// no directives: the model pin is what says kev (guard kevSentinel below)
	return { kind: "choose", scope: c.hub ? "hub" : "all", hub: c.hub, prefixes: [] };
};

/** True when the model layer says kev — the sentinel trigger. */
export const kevSentinel = (o: {
	modelPin: string | null;
	/** the chain's directive tokens (kev may be one of them). */
	directives: { value: string; kind: "must" | "prefer" | "can" }[];
	confModel: string | null;
}): boolean =>
	o.modelPin === "kev" ||
	o.confModel === "kev" ||
	o.directives.some(
		(d) => (d.kind === "must" || d.kind === "prefer") && d.value === "kev",
	);

/** A kev token is the TRIGGER, never a chain target — strip it before the
 * rules classify what remains (must=kev + hub= is rule 2, not rule 6). */
export const stripKevDirectives = (c: KevChainView): KevChainView => ({
	...c,
	directives: c.directives.filter((d) => d.value !== "kev"),
});

/** Filter a candidate model list through glob prefixes ("" = all). */
export const globFilter = (models: string[], prefixes: string[]): string[] =>
	prefixes.length === 0 || prefixes.includes("")
		? models
		: models.filter((m) => prefixes.some((p) => m.startsWith(p)));
