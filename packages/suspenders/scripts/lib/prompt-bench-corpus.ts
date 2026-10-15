// prompt-bench-corpus.ts — W368 bench corpus generator. Deterministic,
// seeded fleet-shaped prompt pairs: each seed yields a VERBOSE form (the
// compressor's input: politeness, filler, meta sentences) and a TERSE form
// (the enhancer's input: shorthand with the tokens intact). The protected
// tokens (paths, flags, ports, hex ids, ms budgets) are known by
// construction, so retention scoring is exact — no hand-labeling, no LLM
// judge. Same seed number → byte-identical corpus (pinned in tests).

/** mulberry32 — small seeded PRNG, enough for corpus shaping. */
const mulberry32 = (seed: number): (() => number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const PKGS = ["suspenders", "belt", "buckle", "speedy", "local", "blam"];
const SUBS = ["hooks/lib", "bin", "src", "scripts/lib", "test", "deploy"];
const FILES = [
	"govdb.ts",
	"router-shim.ts",
	"engine.ts",
	"swarm.ts",
	"tiers.ts",
	"probe.ts",
];
const FLAGS = [
	"--dry-run",
	"--sha",
	"--summary",
	"--timeout",
	"--wire",
	"--force",
	"--json",
];
const PORTS = [4000, 4101, 7799, 8901, 8902, 8903, 8912, 8913];
const MS = [250, 1024, 2500, 4000, 15000, 60000];
const VERBS = [
	"fix",
	"wire",
	"bench",
	"audit",
	"prune",
	"split",
	"mint",
	"deploy",
	"verify",
	"port",
];
const OBJECTS = [
	"lane",
	"fallback",
	"probe",
	"capsule",
	"ledger",
	"ring",
	"ladder",
	"sidecar",
	"fixture",
	"corpus",
];

const HEX_ALPHABET = "0123456789abcdef";
const hexId = (r: () => number, len: number): string => {
	let out = "";
	for (let i = 0; i < len; i++)
		out += HEX_ALPHABET[Math.floor(r() * HEX_ALPHABET.length)];
	return out;
};

const pick = <T>(r: () => number, xs: T[]): T =>
	xs[Math.floor(r() * xs.length)];

export interface BenchSeed {
	/** stable seed id (sb-<index>) */
	id: string;
	/** protected tokens that MUST survive any faithful transform */
	tokens: string[];
	/** content words (besides tokens) a faithful output keeps */
	keyWords: string[];
	/** filler-laden verbose prompt — the compressor's input */
	verbose: string;
	/** shorthand prompt — the enhancer's input */
	terse: string;
}

/** Build n deterministic paired prompts. Same (n, seed) → same corpus. */
export function buildCorpus(n: number, seed = 20261016): BenchSeed[] {
	const r = mulberry32(seed);
	const out: BenchSeed[] = [];
	const seen = new Set<string>();
	while (out.length < n) {
		const verb = pick(r, VERBS);
		const obj = pick(r, OBJECTS);
		const path = `packages/${pick(r, PKGS)}/${pick(r, SUBS)}/${pick(r, FILES)}`;
		const flag1 = pick(r, FLAGS);
		const flag2 = pick(r, FLAGS);
		const port = pick(r, PORTS);
		const ms = pick(r, MS);
		const h1 = hexId(r, 6);
		const h2 = hexId(r, 8);
		const verbose = [
			`Hi — could you please ${verb} the ${obj} handling in ${path}?`,
			"Thanks so much in advance; this is important to the fleet.",
			`Keep the sidecar timeout at ${ms}ms and do not remove ${flag1}.`,
			`Reproduce against port ${port} first (trace ${h1}), then run bun test ${flag2}.`,
			"It is worth noting that the previous attempt at this prompt was written in a hurry.",
			`Commit as ${h2} — subject starts with the item id.`,
		].join(" ");
		const terse = `${verb} ${obj} in ${path}; timeout ${ms}ms; keep ${flag1}; port ${port} trace ${h1}; bun test ${flag2}; commit ${h2}.`;
		if (flag1 === flag2 || seen.has(verbose)) continue;
		seen.add(verbose);
		out.push({
			id: `sb-${out.length}`,
			tokens: [
				path,
				flag1,
				flag2,
				String(port),
				h1,
				h2,
				String(ms),
			] as string[],
			keyWords: [verb, obj],
			verbose,
			terse,
		});
	}
	return out;
}
