// tiers.ts — the condense tier table. Tiers are DATA: a tier row names the
// protect grammar + the ordered rule table + the pipeline shape; engine.ts
// owns the only machinery. Reproduction doctrine (W367.1): the
// politeness/caveman tables copy the suspenders board condenser
// (packages/suspenders/hooks/board/prompt-transform.ts) and the aggressive
// table copies belt ref-condense/1 (packages/belt/bench/arena/condense.ts)
// EXACTLY — the parity pins freeze those bytes; do not extend, reproduce.
import {
	type CasedRule,
	condense,
	type CondenseResult,
	type Step,
	type TierSpec,
	PROTECT_GRAMMARS,
	type ReplaceRule,
} from "./engine.ts";

// ─── suspenders W287 politeness ruleset (verbatim, order matters) ────────
// Greetings, thanks, please/kindly, could/would-you wrappers and "go ahead and"
// add no instruction. Hedges, quantifiers and scope words (just, maybe,
// only, very, quite, perhaps, really, kind of…) carry meaning and are
// NEVER stripped in production tiers (executable law L2).
const SUSPENDERS_FILLER: ReplaceRule[] = [
	{
		name: "filler:greeting",
		re: /^\s*(?:hi|hey|hello)(?: there)?\b[,!.]?/gim,
		rep: "",
	},
	{
		name: "filler:thanks",
		re: /\b(?:thanks|thank you)(?: (?:so|very) much)?(?: in advance)?\b[,!.]?/gi,
		rep: "",
	},
	{
		name: "filler:request-wrapper",
		re: /\b(?:could|can|would) you (?:please )?(?:kindly )?\b/gi,
		rep: "",
	},
	{
		name: "filler:please-kindly",
		re: /\b(?:please|kindly)\b[,]?/gi,
		rep: "",
	},
	{ name: "filler:go-ahead", re: /\bgo ahead and\b/gi, rep: "" },
	// doubled words ("the the"), case-insensitive, letters only
	{
		name: "dedupe:doubled-word",
		re: /\b([A-Za-z]+)(\s+\1\b)+/gi,
		rep: "$1",
	},
];

// W334 meta-sentence strip (verbatim from the suspenders board condenser):
// sentences ABOUT the prompt/request machinery carry no task content —
// drop them. Conservative: a task that genuinely says "prompt the user"
// never matches "the prompt" with these shapes.
export const META_RE =
	/\b(this prompt|the prompt(?! the user)|between when this|the actual requested action|although this)\b/i;

// suspenders tidy() chain (verbatim, order matters)
const SUSPENDERS_TIDY: ReplaceRule[] = [
	{ name: "tidy:bang-run", re: /([!?])\1+/g, rep: "$1" },
	{ name: "tidy:space-run", re: /[ \t]+/g, rep: " " },
	{ name: "tidy:space-before-punct", re: / +([,.;:!?])/g, rep: "$1" },
	{ name: "tidy:punct-run", re: /([,;:])(?:\s*[,;:])+/g, rep: "$1" },
	{ name: "tidy:punct-before-eos", re: /[,;:]+\s*([.!?])/g, rep: "$1" },
	{ name: "tidy:clause-tail", re: /[,;:]+[ \t]*$/gm, rep: "" },
	{ name: "tidy:clause-head", re: /(^|[\n.!?]\s*)[,;:]\s*/g, rep: "$1" },
	{ name: "tidy:trailing-space", re: /[ \t]+\n/g, rep: "\n" },
	{ name: "tidy:leading-space", re: /\n[ \t]+/g, rep: "\n" },
	{ name: "tidy:blank-run", re: /\n{3,}/g, rep: "\n\n" },
];

// ─── belt ref-condense/1 ruleset (verbatim, order matters) ───────────────
// Verbose phrase → concise phrase (case-insensitive, whole words).
const PHRASES: [string, string][] = [
	["it is important to note that", ""],
	["it should be noted that", ""],
	["please note that", ""],
	["note that", ""],
	["i would like you to", ""],
	["i want you to", ""],
	["i need you to", ""],
	["could you please", ""],
	["would you please", ""],
	["could you", ""],
	["would you", ""],
	["can you", ""],
	["feel free to", ""],
	["be sure to", ""],
	["make sure to", ""],
	["make sure that", "ensure"],
	["due to the fact that", "because"],
	["at this point in time", "now"],
	["for the purpose of", "for"],
	["in the event that", "if"],
	["with regard to", "about"],
	["with respect to", "about"],
	["in regard to", "about"],
	["in order to", "to"],
	["each and every", "each"],
	["as well as", "and"],
	["a number of", "several"],
	["is able to", "can"],
	["are able to", "can"],
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// shared phrase→rule mapping (W238: one builder for both tables — the
// belt table's rule shapes stay byte-identical, so the parity pins hold)
const phraseRules = (phrases: [string, string][]): CasedRule[] =>
	phrases.map(([from, to]) => ({
		name: `phrase:${from.replace(/\s+/g, "-")}`,
		re: new RegExp(
			`\\b${from.split(" ").map(esc).join("\\s+")}\\b,?[ \\t]*`,
			"gi",
		),
		to,
	}));
const PHRASE_RULES: CasedRule[] = phraseRules(PHRASES);

// W238 packet phrase table (architecture/operational doc prose) —
// conciseness rewrites that preserve meaning: the deterministic analog of
// LLMLingua-2's task-agnostic token keep/drop for boilerplate-heavy docs.
// Pure drops only for discourse markers (the restatement after "in other
// words" carries the content; the marker does not).
const PACKET_PHRASES: [string, string][] = [
	["the fact that", "that"],
	["prior to", "before"],
	["subsequent to", "after"],
	["in spite of", "despite"],
	["with the exception of", "except"],
	["a variety of", "several"],
	["the majority of", "most"],
	["at the present time", "now"],
	["in the near future", "soon"],
	["has the ability to", "can"],
	["have the ability to", "can"],
	["is required to", "must"],
	["are required to", "must"],
	["it is possible that", "may"],
	["in addition to this", "also"],
	["in addition to that", "also"],
	["as mentioned above", ""],
	["as noted above", ""],
	["as described above", ""],
	["in other words", ""],
	["that is to say", ""],
	["put differently", ""],
];
const PACKET_PHRASE_RULES: CasedRule[] = phraseRules(PACKET_PHRASES);

// belt FILLER: the ref-condense hedge list. It VIOLATES the W287 hedge law
// by design (strips just/very/really/quite), which is exactly why the
// aggressive tier is EVAL-ONLY, excluded from production (spec law L2).
const BELT_HEDGES = [
	"please",
	"kindly",
	"basically",
	"actually",
	"really",
	"simply",
	"just",
	"very",
	"quite",
	"literally",
	"certainly",
	"definitely",
];

const FILLER_RULE: CasedRule = {
	name: "filler:word",
	re: new RegExp(`\\b(?:${BELT_HEDGES.join("|")})\\b,?[ \\t]*`, "gi"),
	to: "",
};

// belt condenseProse spacing cleanup (verbatim, order matters)
const BELT_SPACING: ReplaceRule[] = [
	{ name: "tidy:multi-space", re: /[ \t]{2,}/g, rep: " " },
	{ name: "tidy:space-before-punct", re: /[ \t]+([,.;:!?)])/g, rep: "$1" },
	{ name: "tidy:space-after-open-paren", re: /\([ \t]+/g, rep: "(" },
	{ name: "tidy:edge-space", re: /^[ \t]+|[ \t]+$/gm, rep: "" },
	{ name: "tidy:blank-run", re: /\n{3,}/g, rep: "\n\n" },
];

const politenessSteps: Step[] = [
	{ kind: "replace", scope: "line", rules: SUSPENDERS_FILLER },
	{ kind: "replace", scope: "text", rules: SUSPENDERS_TIDY },
	{ kind: "trim-lines" },
	{ kind: "trim" },
];

const cavemanSteps: Step[] = [
	{ kind: "replace", scope: "line", rules: SUSPENDERS_FILLER },
	{
		kind: "sentence-strip",
		scope: "line",
		name: "meta:sentence",
		re: META_RE,
	},
	{
		kind: "sentence-dedupe",
		scope: "line",
		mode: "jaccard",
		threshold: 0.75,
	},
	{ kind: "replace", scope: "text", rules: SUSPENDERS_TIDY },
	{ kind: "trim-lines" },
	{ kind: "trim" },
];

// the article strip, shared verbatim by aggressive + machine (W367.4)
const ARTICLE_STRIPS: ReplaceRule[] = [
	{ name: "strip:article-the", re: /\bthe[ \t]+(?=[a-z0-9])/g, rep: "" },
	{
		name: "strip:article-an",
		re: /(?<=[ \t])an?[ \t]+(?=[a-z])(?!(?:and|or|is|are|b)\b)/g,
		rep: "",
	},
];

const aggressiveSteps: Step[] = [
	{ kind: "cased-replace", rules: PHRASE_RULES },
	{ kind: "cased-replace", rules: [FILLER_RULE] },
	{ kind: "replace", scope: "text", rules: ARTICLE_STRIPS },
	{ kind: "cap-resolve" },
	{ kind: "replace", scope: "text", rules: BELT_SPACING },
	{ kind: "sentence-dedupe", scope: "text", mode: "exact", minWords: 3 },
];

// machine (W367.4) — aggressive MINUS hedge removal. The phrase table,
// article strips, cap-resolve, belt spacing chain and exact sentence
// dedupe carry over; the belt FILLER_RULE cased-replace step (the hedge
// list just/very/really/simply/quite/literally/basically/actually/
// certainly/definitely) is deliberately ABSENT — law L2: a hedge in an
// AGENTS.md ("only touch X") is meaning. Additive tier, no parity pin:
// it carries the union protect grammar (the engine's full L1 surface —
// adds ~~~ fences, paths, flags, URLs over belt's). Existing tiers are
// untouched (the pins prove it), so CONDENSE_VERSION does not bump.
const machineSteps: Step[] = [
	{ kind: "cased-replace", rules: PHRASE_RULES },
	{ kind: "replace", scope: "text", rules: ARTICLE_STRIPS },
	{ kind: "cap-resolve" },
	{ kind: "replace", scope: "text", rules: BELT_SPACING },
	{ kind: "sentence-dedupe", scope: "text", mode: "exact", minWords: 3 },
];

// packet (W238) — machine PLUS the packet phrase table (doc-prose
// conciseness rewrites) and exact line dedupe (repeated boilerplate
// lines). LLMLingua-2-class: deeper task-agnostic extraction, still rule-
// deterministic and offline. Union protect grammar — file pointers stay
// verbatim (W112). Additive tier, no parity pin, CONDENSE_VERSION unbumped
// (machine precedent).
const packetSteps: Step[] = [
	{ kind: "cased-replace", rules: [...PHRASE_RULES, ...PACKET_PHRASE_RULES] },
	{ kind: "replace", scope: "text", rules: ARTICLE_STRIPS },
	{ kind: "cap-resolve" },
	{ kind: "replace", scope: "text", rules: BELT_SPACING },
	{ kind: "sentence-dedupe", scope: "text", mode: "exact", minWords: 3 },
	{ kind: "line-dedupe", minWords: 2 },
];

export type TierName =
	| "politeness"
	| "caveman"
	| "aggressive"
	| "machine"
	| "packet";

export const TIERS: Record<TierName, TierSpec> = {
	politeness: {
		name: "politeness",
		protect: PROTECT_GRAMMARS.suspenders,
		guardSentinels: false,
		dedupeSlots: false,
		steps: politenessSteps,
		finalTrim: "none",
		fixpointRounds: 1,
	},
	caveman: {
		name: "caveman",
		protect: PROTECT_GRAMMARS.suspenders,
		guardSentinels: false,
		dedupeSlots: false,
		steps: cavemanSteps,
		finalTrim: "none",
		fixpointRounds: 1,
	},
	aggressive: {
		name: "aggressive",
		protect: PROTECT_GRAMMARS.belt,
		guardSentinels: true,
		dedupeSlots: true,
		steps: aggressiveSteps,
		finalTrim: "whole",
		fixpointRounds: 5,
	},
	machine: {
		name: "machine",
		protect: PROTECT_GRAMMARS.union,
		guardSentinels: true,
		dedupeSlots: true,
		steps: machineSteps,
		finalTrim: "whole",
		fixpointRounds: 5,
	},
	packet: {
		name: "packet",
		protect: PROTECT_GRAMMARS.union,
		guardSentinels: true,
		dedupeSlots: true,
		steps: packetSteps,
		finalTrim: "whole",
		fixpointRounds: 5,
	},
};

// belt's arena labels this tier ref-condense/1 — kept as the legacy tag so
// the arena's historical run-ids stay addressable until W368 retires it.
export const AGGRESSIVE_LEGACY_VERSION = "ref-condense/1";

export function condenseTier(name: TierName, input: string): CondenseResult {
	return condense(input, TIERS[name]);
}
