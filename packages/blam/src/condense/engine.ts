// engine.ts — the blam canonical prompt-condense engine (W367).
// Zero-dep, pure, deterministic: no clock, no seed, no locale, no I/O —
// the same input + the same tier table always yield byte-identical output
// (law L6). Pipeline: mask protected spans → run the tier's rule table →
// restore verbatim (law L1). Every condense() call returns
// { text, rules } where `rules` is the ordered rules-fired audit list
// (law L5).
//
// Parity note (W367.1): politeness/caveman carry the suspenders board
// protect grammar and aggressive carries the belt ref-condense grammar,
// so the parity pins hold byte-for-byte until the consumer swap lands
// (spec migration steps 2 and 4). PROTECT_GRAMMARS.union is the engine's
// full protect surface; widening a tier's grammar is output-affecting and
// bumps CONDENSE_VERSION.

// ─── protect grammar (law L1) ────────────────────────────────────────────
// The two parity-source grammars, verbatim, plus their union (which adds
// ~~~ fences). Ordered alternation: the first alternative matching at a
// position wins.
export const PROTECT_GRAMMARS = {
	// suspenders board grammar
	// (packages/suspenders/hooks/board/prompt-transform.ts): fences, inline
	// code, URLs, paths (/a/b, ./x, ~/x, a/b.ts), flags, dotted identifiers
	suspenders:
		/```[\s\S]*?```|`[^`\n]+`|\bhttps?:\/\/\S+|(?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]*)*|\b[\w-]+\/[\w./-]+|--?[A-Za-z][\w-]*|\b\w+(?:\.\w+)+\b/g,
	// belt ref-condense grammar
	// (packages/belt/bench/arena/condense.ts): """ blocks, fences, <log>
	// blocks, inline code, quoted strings, <placeholders>, FORMAT: lines
	belt: /"""[\s\S]*?"""|```[\s\S]*?```|<log>[\s\S]*?<\/log>|`[^`\n]*`|"[^"\n]*"|<[^<>\n]{1,40}>|^[A-Z][A-Z_]+:.*$/gm,
	// union (spec law L1): belt's blocks + ~~~ fences + suspenders'
	// technical surface — the full protect surface the engine can enforce
	union:
		/"""[\s\S]*?"""|~~~[\s\S]*?~~~|```[\s\S]*?```|<log>[\s\S]*?<\/log>|`[^`\n]*`|"[^"\n]*"|<[^<>\n]{1,40}>|^[A-Z][A-Z_]+:.*$|\bhttps?:\/\/\S+|(?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]*)*|\b[\w-]+\/[\w./-]+|--?[A-Za-z][\w-]*|\b\w+(?:\.\w+)+\b/gm,
} as const;

// Private-use sentinels: never typed by a human, survive every rule.
// (Same scheme as the parity sources, normalised to one range — the chars
// are engine-internal and never reach the output.)
export const OPEN = "\uE000";
export const CLOSE = "\uE001";
export const CAP = "\uE002"; // marks "capitalise the next letter" after a removal
const SENTINELS = /[\uE000-\uE002]/;

// ─── rule + step tables (tiers are DATA — the engine owns no ruleset) ────
export interface ReplaceRule {
	/** audit name (law L5), e.g. "filler:greeting" */
	name: string;
	re: RegExp;
	rep: string;
}

export interface CasedRule {
	/** audit name (law L5), e.g. "phrase:in-order-to" */
	name: string;
	re: RegExp;
	/** replacement phrase; "" = pure drop (case restored via CAP markers) */
	to: string;
}

export type Step =
	| { kind: "replace"; scope: "line" | "text"; rules: ReplaceRule[] }
	| { kind: "cased-replace"; rules: CasedRule[] }
	// drops whole sentences matching `re` (non-global); audit via `name`
	| {
			kind: "sentence-strip";
			scope: "line" | "text";
			name: string;
			re: RegExp;
	  }
	| {
			kind: "sentence-dedupe";
			scope: "line" | "text";
			/** jaccard: drop near-duplicates of a kept sentence at ≥ threshold */
			mode: "jaccard" | "exact";
			threshold?: number;
			/** exact mode: sentences with fewer words are never dropped */
			minWords?: number;
	  }
	// W238 packet tier: an exact (normalized) repeat LINE is boilerplate —
	// drop later occurrences, keep the first. Lines with fewer than
	// minWords words are never dropped.
	| { kind: "line-dedupe"; minWords?: number }
	| { kind: "cap-resolve" }
	| { kind: "trim-lines" }
	| { kind: "trim" };

export interface TierSpec {
	name: string;
	protect: RegExp;
	/** belt law: an input already carrying sentinels passes through */
	guardSentinels: boolean;
	/** identical protected spans share one slot (belt's mask) */
	dedupeSlots: boolean;
	/** the ordered rule table run between mask and restore */
	steps: Step[];
	/** whole-text trim after restore (belt trims last; suspenders trims
	 *  pre-restore via explicit trim steps) */
	finalTrim: "none" | "whole";
	/** >1: re-run to a fixpoint, belt-style; 1: single pass */
	fixpointRounds: number;
}

export interface CondenseResult {
	text: string;
	rules: string[];
}

// ─── audit ───────────────────────────────────────────────────────────────
function fire(fired: string[], name: string): void {
	if (!fired.includes(name)) fired.push(name);
}

function applyReplace(t: string, rule: ReplaceRule, fired: string[]): string {
	const out = t.replace(rule.re, rule.rep);
	if (out !== t) fire(fired, rule.name);
	return out;
}

// belt's replaceCased, verbatim: keeps the case of the first letter; an
// empty replacement of a capitalised match records a CAP marker so the
// following word is capitalised at the cap-resolve step.
function replaceCased(s: string, re: RegExp, to: string): string {
	return s.replace(re, (m: string) => {
		const upper = /^[A-Z]/.test(m);
		if (!to) return upper ? CAP : "";
		const tail = /[ \t]$/.test(m) ? " " : "";
		const word = upper ? `${to.charAt(0).toUpperCase()}${to.slice(1)}` : to;
		return `${word}${tail}`;
	});
}

function applyCased(t: string, rule: CasedRule, fired: string[]): string {
	const out = replaceCased(t, rule.re, rule.to);
	if (out !== t) fire(fired, rule.name);
	return out;
}

// ─── sentence machinery ──────────────────────────────────────────────────
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

// sentence-level redundancy (suspenders W334): a near-duplicate of an
// earlier sentence adds nothing — drop it, keep the first occurrence
function jaccardDedupe(s: string, threshold: number, fired: string[]): string {
	const kept = new Set<Set<string>>(); // normalized token sets of kept sentences
	const words = (t: string): Set<string> =>
		new Set(t.toLowerCase().match(/[a-z0-9']+/g) ?? []);
	const jaccard = (a: Set<string>, b: Set<string>): number => {
		let inter = 0;
		for (const w of a) if (b.has(w)) inter++;
		const union = a.size + b.size - inter;
		return union === 0 ? 0 : inter / union;
	};
	return s
		.split(SENTENCE_SPLIT)
		.filter((sent) => {
			const tokens = words(sent);
			if (tokens.size === 0) return true;
			for (const k of kept) {
				if (jaccard(tokens, k) >= threshold) {
					fire(fired, "dedupe:sentence");
					return false;
				}
			}
			kept.add(tokens);
			return true;
		})
		.join(" ");
}

// belt's exact dedupe: an exact (normalized) repeat of an earlier sentence
// (≥ minWords) is dropped; separators are preserved verbatim
function exactDedupe(s: string, minWords: number, fired: string[]): string {
	const parts = s.split(/(?<=[.!?])(\s+)/);
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		const sent = parts[i] ?? "";
		const sep = parts[i + 1] ?? "";
		const key = sent.toLowerCase().replace(/\s+/g, " ").trim();
		if (key.split(" ").length >= minWords && seen.has(key)) {
			fire(fired, "dedupe:sentence");
			continue;
		}
		seen.add(key);
		out.push(sent, sep);
	}
	return out.join("");
}

// ─── mask / restore ──────────────────────────────────────────────────────
interface Slots {
	masked: string;
	slots: string[];
}

function mask(text: string, re: RegExp, dedupeSlots: boolean): Slots {
	const slots: string[] = [];
	const index = new Map<string, number>();
	const masked = text.replace(re, (m: string) => {
		if (dedupeSlots) {
			let i = index.get(m);
			if (i === undefined) {
				i = slots.length;
				slots.push(m);
				index.set(m, i);
			}
			return `${OPEN}${i}${CLOSE}`;
		}
		slots.push(m);
		return `${OPEN}${slots.length - 1}${CLOSE}`;
	});
	return { masked, slots };
}

function restore(text: string, slots: string[]): string {
	return text.replace(
		new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
		(_, i: string) => slots[Number(i)] ?? "",
	);
}

// ─── step executor (the only code paths; tiers pick among them as data) ──
function runStep(t: string, step: Step, fired: string[]): string {
	switch (step.kind) {
		case "replace": {
			if (step.scope === "line") {
				return t
					.split("\n")
					.map((line) => {
						let cur = line;
						for (const rule of step.rules) cur = applyReplace(cur, rule, fired);
						return cur;
					})
					.join("\n");
			}
			let cur = t;
			for (const rule of step.rules) cur = applyReplace(cur, rule, fired);
			return cur;
		}
		case "cased-replace": {
			let cur = t;
			for (const rule of step.rules) cur = applyCased(cur, rule, fired);
			return cur;
		}
		case "sentence-strip": {
			const drop = (s: string): string[] => {
				const kept: string[] = [];
				for (const sent of s.split(SENTENCE_SPLIT)) {
					if (step.re.test(sent)) {
						fire(fired, step.name);
						continue;
					}
					kept.push(sent);
				}
				return kept;
			};
			return step.scope === "line"
				? t
						.split("\n")
						.map((line) => drop(line).join(" "))
						.join("\n")
				: drop(t).join(" ");
		}
		case "sentence-dedupe": {
			const threshold = step.threshold ?? 0.75;
			const minWords = step.minWords ?? 3;
			const run = (s: string): string =>
				step.mode === "jaccard"
					? jaccardDedupe(s, threshold, fired)
					: exactDedupe(s, minWords, fired);
			return step.scope === "line" ? t.split("\n").map(run).join("\n") : run(t);
		}
		case "line-dedupe": {
			const minWords = step.minWords ?? 2;
			const seen = new Set<string>();
			const out: string[] = [];
			for (const line of t.split("\n")) {
				const key = line.toLowerCase().replace(/\s+/g, " ").trim();
				if (key.split(" ").length >= minWords && seen.has(key)) {
					fire(fired, "dedupe:line");
					continue;
				}
				seen.add(key);
				out.push(line);
			}
			return out.join("\n");
		}
		case "cap-resolve":
			return t
				.replace(new RegExp(`${CAP}[ \\t]*([a-z])`, "g"), (_m, c: string) =>
					c.toUpperCase(),
				)
				.replaceAll(CAP, "");
		case "trim-lines":
			return t
				.split("\n")
				.map((line) => line.trim())
				.join("\n");
		case "trim":
			return t.trim();
	}
}

// ─── the pipeline ────────────────────────────────────────────────────────
export function condense(input: string, tier: TierSpec): CondenseResult {
	const fired: string[] = [];
	if (tier.guardSentinels && SENTINELS.test(input))
		return { text: input, rules: fired };
	const once = (s: string): string => {
		const { masked, slots } = mask(s, tier.protect, tier.dedupeSlots);
		let t = masked;
		for (const step of tier.steps) t = runStep(t, step, fired);
		t = restore(t, slots);
		return tier.finalTrim === "whole" ? t.trim() : t;
	};
	let out = once(input);
	for (let i = 1; i < tier.fixpointRounds; i++) {
		const next = once(out);
		if (next === out) break;
		out = next;
	}
	return { text: out, rules: fired };
}
