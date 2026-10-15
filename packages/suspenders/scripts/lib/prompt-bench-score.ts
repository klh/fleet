// prompt-bench-score.ts — W368 deterministic transform scoring. No LLM
// judge: retention of protected tokens + content words, hallucination
// guard (identifier-shaped output absent from the input), and a transform
// secondary (compression ratio for compress, length/opening sanity for
// enhance). Composite 0–100. Every component is reproducible from
// (input, output) alone — the corpus pins the token list by construction.
import type { BenchSeed } from "./prompt-bench-corpus.ts";

/** Identifier-shaped tokens present in a text: paths, flags, hex runs,
 *  bare multi-digit numbers. The addition guard compares these sets. */
export function extractIdents(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g))
		out.add(m[0]);
	for (const m of text.matchAll(/--[a-z][a-z0-9-]*/g)) out.add(m[0]);
	for (const m of text.matchAll(/\b[a-f0-9]{6,}\b/g)) out.add(m[0]);
	for (const m of text.matchAll(/\b\d{2,6}\b/g)) out.add(m[0]);
	return out;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export interface LegScore {
	/** 0..1 — protected tokens present verbatim (weight 5/6) + key content
	 *  words present (1/6), normalized to 1 */
	retention: number;
	/** identifier-shaped additions not in the input (hallucination guard) */
	additions: number;
	/** bytes out / bytes in */
	ratio: number;
	/** transform secondary 0..1: compress → compression depth; enhance →
	 *  length sanity + no service-desk opener */
	secondary: number;
	/** composite 0..100 */
	score: number;
}

const OPENERS = /^(?:sure|certainly|of course|here(?:'s| is)|i'll|i can|i'd)\b/i;

export function scoreCompress(
	seed: BenchSeed,
	output: string,
): LegScore {
	const hit = seed.tokens.filter((t) => output.includes(t)).length;
	const kw = seed.keyWords.filter((w) =>
		output.toLowerCase().includes(w),
	).length;
	const retention = clamp01(
		(0.5 * (hit / seed.tokens.length) + 0.1 * (kw / seed.keyWords.length)) / 0.6,
	);
	const inIdents = extractIdents(
		seed.verbose.replace(/\[bench nonce [0-9a-z]+\]/g, ""),
	);
	const adds = [...extractIdents(output)].filter(
		(x) => !inIdents.has(x),
	).length;
	const ratio = Buffer.byteLength(output, "utf8") / Math.max(1, Buffer.byteLength(seed.verbose, "utf8"));
	const secondary = clamp01((1 - ratio) / 0.5);
	const score = Math.round(
		100 * (0.6 * retention + 0.25 * (adds === 0 ? 1 : Math.max(0, 1 - adds * 0.25)) + 0.15 * secondary),
	);
	return { retention, additions: adds, ratio, secondary, score };
}

export function scoreEnhance(seed: BenchSeed, output: string): LegScore {
	const hit = seed.tokens.filter((t) => output.includes(t)).length;
	const kw = seed.keyWords.filter((w) =>
		output.toLowerCase().includes(w),
	).length;
	const retention = clamp01(
		(0.5 * (hit / seed.tokens.length) + 0.1 * (kw / seed.keyWords.length)) / 0.6,
	);
	const inIdents = extractIdents(
		seed.terse.replace(/\[bench nonce [0-9a-z]+\]/g, ""),
	);
	const adds = [...extractIdents(output)].filter(
		(x) => !inIdents.has(x),
	).length;
	const ratio = Buffer.byteLength(output, "utf8") / Math.max(1, Buffer.byteLength(seed.terse, "utf8"));
	const opener = OPENERS.test(output.trimStart());
	const secondary =
		ratio <= 4 ? (opener ? 0.5 : 1) : 0;
	const score = Math.round(
		100 * (0.6 * retention + 0.25 * (adds === 0 ? 1 : Math.max(0, 1 - adds * 0.25)) + 0.15 * secondary),
	);
	return { retention, additions: adds, ratio, secondary, score };
}

/** median of a numeric list (average of middle two for even n) */
export function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
