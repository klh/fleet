// router-condense.ts — W304.2: knob-gated inbound prompt condensation for
// the :4000 production router (the deterministic Anthropic→OpenAI shim).
// The router consumes the blam canonical condense engine
// (packages/blam/src/condense/, CONDENSE_VERSION blam-condense/1) — the same
// engine the suspenders board condenser delegates to (W367.2).
//
// Audience split (W304.2): :4000 serves BOTH agent lanes — whose briefs are
// already condensed at SOURCE by suspenders since W334 (re-condensing is
// near-idempotent but wasteful) — AND interactive/CLI users riding :4000
// directly with raw prose. The knob therefore defaults OFF: existing traffic
// stays byte-identical until the owner sets
// ~/.claude/local-llm/prefs.json → {"condense": {"enabled": true}}.
//
// Tier: caveman (the production inbound tier; politeness selectable).
// aggressive/machine are deliberately NOT offered here — aggressive strips
// hedges (blam law L2: eval-only) and machine strips articles (machine-
// facing). Caveman keeps hedges/quantifiers/scope words, restores fences,
// inline code, URLs and paths verbatim (law L1), and is deterministic
// (law L6).
//
// Cache-key law: belt's router keeps NO response/prompt cache. The only
// key-like surfaces are the routing-log fingerprint (sha256 of the RAW
// classified text — logging only) and upstream MLX prefix caches (keyed on
// the literal wire text, so a knob flip only causes cold prefixes, never
// wrong answers). Any FUTURE response cache MUST include the knob state —
// CondenseMeta below (version + tier + rules) is exactly that key input.
//
// Classification (scoreComplexity/arithmetic/Kev/Danish) runs on the RAW
// text upstream of this module: routing is identical with the knob on or
// off — only the wire payload sent to the specialist shrinks.
import { condenseTier, type TierName } from "../../blam/src/condense/tiers.ts";
import { CONDENSE_VERSION } from "../../blam/src/condense/version.ts";
import type { ChatMessage } from "./router-core.ts";

/** Production tiers only — the eval-only/machine-facing tiers stay out. */
export type CondenseTier = Extract<TierName, "caveman" | "politeness">;

export interface CondensePrefs {
	enabled?: boolean;
	tier?: CondenseTier;
}

export interface CondenseMeta {
	version: string;
	tier: CondenseTier;
	/** ordered rules-fired audit, merged across messages (blam law L5) */
	rules: string[];
}

/** Knob default: OFF — dispatch traffic is pre-condensed at source (W334). */
export const CONDENSE_PREFS_DEFAULT: CondensePrefs = {
	enabled: false,
	tier: "caveman",
};

const CONDENSE_TIERS: ReadonlySet<string> = new Set(["caveman", "politeness"]);

/** Only a boolean `enabled` and a known production tier pass through;
 *  everything else falls back to the default (fail-safe = OFF). */
export function resolveCondensePrefs(raw: unknown): Required<CondensePrefs> {
	if (typeof raw !== "object" || raw === null)
		return { ...CONDENSE_PREFS_DEFAULT };
	const p = raw as CondensePrefs;
	const tier: CondenseTier =
		typeof p.tier === "string" && CONDENSE_TIERS.has(p.tier)
			? (p.tier as CondenseTier)
			: (CONDENSE_PREFS_DEFAULT.tier as CondenseTier);
	return { enabled: p.enabled === true, tier };
}

export interface InboundCondense {
	messages: ChatMessage[];
	/** null = knob off: byte-identical passthrough, no metadata emitted. */
	meta: CondenseMeta | null;
}

/** The ONE call the router makes. Knob off → the same array back, untouched
 *  (same identity — the cheapest possible passthrough). Knob on → user
 *  messages condensed; system (the harness prompt) and assistant (the
 *  model's own history) ride verbatim; metadata always emitted. */
export function applyInboundCondense(
	messages: ChatMessage[],
	raw: unknown,
): InboundCondense {
	const prefs = resolveCondensePrefs(raw);
	if (!prefs.enabled) return { messages, meta: null };
	const rules: string[] = [];
	const out = messages.map((m) => {
		if (m.role !== "user") return m;
		const r = condenseTier(prefs.tier, m.content);
		for (const name of r.rules) if (!rules.includes(name)) rules.push(name);
		// never condense into nothing — the human's words win (W334 rule)
		const text = r.text.trim() === "" ? m.content : r.text;
		return { ...m, content: text };
	});
	return {
		messages: out,
		meta: { version: CONDENSE_VERSION, tier: prefs.tier, rules },
	};
}
