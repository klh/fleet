// hooks/lib/gates/wire-model-check.ts — W1302.6 (O3): assert the review leg's
// SERVED wire model against the model class the review REQUESTED. A
// Flash-requested review served by another provider's model landed as a clean
// PASS receipt (W1278.1, wire_model=chatgpt/gpt-6-sol); receipts recorded the
// served model but nothing compared the two. This module owns the comparison;
// review-lane.ts downgrades a mismatched PASS to FAIL and review-receipt.ts
// refuses to authorize a merge on it.

/** Strip routing/provider decoration down to the comparable model-class core:
 *  drop any `provider/` prefix (keep the last path segment), drop a
 *  litellm-style `:variant` suffix, lowercase, unify dots to dashes (the
 *  dots-to-dashes alias law is data — root AGENTS.md). */
export const modelCore = (model: string): string => {
	let s = model.trim();
	const slash = s.lastIndexOf("/");
	if (slash >= 0) s = s.slice(slash + 1);
	const colon = s.indexOf(":");
	if (colon >= 0) s = s.slice(0, colon);
	return s.toLowerCase().replaceAll(".", "-");
};

export type WireModelMatch = "match" | "mismatch";

/** Same model class = equal cores, or one core extending the other at a dash
 *  boundary — upstream stamps carry routing prefixes (`zai-glm-5.3-flash`
 *  serves the `glm-5.3-flash` class; `grok-4-flash` does not), and a
 *  `-YYYYMMDD` snapshot stamp is the same class served dated
 *  (`claude-haiku-4-5` serves as `claude-haiku-4-5-20251001`). A
 *  non-numeric extension is a different generation, not a stamp (`glm-5` vs
 *  `glm-5.3-flash`). */
const snapshotStamp = (core: string, base: string): boolean =>
	core.startsWith(`${base}-`) && /^\d{8}$/.test(core.slice(base.length + 1));

export const wireModelMatch = (
	requested: string,
	served: string,
): WireModelMatch => {
	const a = modelCore(requested);
	const b = modelCore(served);
	return a === b ||
		a.endsWith(`-${b}`) ||
		b.endsWith(`-${a}`) ||
		snapshotStamp(b, a) ||
		snapshotStamp(a, b)
		? "match"
		: "mismatch";
};

export interface WireModelAudit {
	requested: string;
	served: string;
	match: WireModelMatch;
}

/** null = unknown — no model was named for the request, or the leg never
 *  stamped a served wire model (bin legs, stubs without a model field).
 *  Unknown never blocks: the guard fires only on a recorded mismatch. */
export const wireModelAudit = (
	requested: string | null | undefined,
	served: string | null | undefined,
): WireModelAudit | null => {
	const r = (requested ?? "").trim();
	const s = (served ?? "").trim();
	if (!r || !s) return null;
	return { requested: r, served: s, match: wireModelMatch(r, s) };
};

export const wireModelMismatch = (
	requested: string | null | undefined,
	served: string | null | undefined,
): boolean => wireModelAudit(requested, served)?.match === "mismatch";
