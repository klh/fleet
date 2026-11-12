// hooks/lib/gates/bench-docs-gate.ts — W951: owner directive #47519. A bench
// landing must carry its ledgers: a bench-shaped item's closing diff
// (the baseline..sha path window) must cover ONE accepted ledger pair —
// the W2990.12 canonical pair (benchmarks/benchmark.md, the top-node
// summary, + benchmarks/benchmarks.json5, the authoritative tree) or the
// legacy root pair (benchmarks.md, the measured result, + doesnt_work.md,
// what failed) — or closure is refused. W949 landed both rows by hand;
// this gate makes a pair mandatory for every bench after it.
// SUSPENDERS_DONE_DOCS=0 disables.
//
// The gate must never flag its own source: no marker vocabulary appears
// contiguously (the W511 scan law).

/** the item shape: title/description names a bench — "bench" (covers
 *  "benchmark") or an "A/B" comparison (case-insensitive substring, owner
 *  directive #47519). */
export const isBenchItem = (
	title?: string | null,
	desc?: string | null,
): boolean => /bench|a\/b/i.test(`${title ?? ""} ${desc ?? ""}`);

/** the legacy root ledgers a bench landing must touch (honored while
 *  present). */
export const BENCH_DOC_PATHS = ["benchmarks.md", "doesnt_work.md"];

/** the W2990.12 canonical pair: the top-node summary + the authoritative
 *  tree. */
export const CANONICAL_BENCH_DOC_PATHS = [
	"benchmarks/benchmark.md",
	"benchmarks/benchmarks.json5",
];

/** accepted ledger pairs — full coverage of ANY one pair satisfies the
 *  gate; mixing across pairs satisfies nothing. */
export const BENCH_DOC_PAIRS: ReadonlyArray<ReadonlyArray<string>> = [
	CANONICAL_BENCH_DOC_PATHS,
	BENCH_DOC_PATHS,
];

export type BenchDocsVerdict = {
	ok: boolean;
	why?: string;
	missing?: string[];
};

/** the done-gate verdict: pure over the path window — no git evidence
 *  reads, so nothing to fail open on; only the env knob bypasses. */
export const benchDocsVerdict = (o: {
	title?: string | null;
	desc?: string | null;
	/** the baseline..sha (or closing-commit) path window from prepareCompletion */
	paths: string[];
	disabled?: boolean;
}): BenchDocsVerdict => {
	if (o.disabled ?? !setting("gates.done_docs")) return { ok: true };
	if (!isBenchItem(o.title, o.desc)) return { ok: true };
	const pairs = BENCH_DOC_PAIRS.map((pair) => ({
		pair,
		missing: pair.filter((p) => !o.paths.includes(p)),
	}));
	if (pairs.some((p) => !p.missing.length)) return { ok: true };
	// report the pair closest to passing — canonical wins ties so the
	// refusal steers toward the current tree shape.
	const best = pairs.reduce((a, b) =>
		b.missing.length < a.missing.length ? b : a,
	);
	return {
		ok: false,
		missing: best.missing,
		why:
			`bench-docs (W951): the item is bench-shaped (title/description names a bench or A/B) ` +
			`but the closing diff covers no accepted ledger pair — canonical ` +
			`${CANONICAL_BENCH_DOC_PATHS.join(" + ")} or legacy ` +
			`${BENCH_DOC_PATHS.join(" + ")}. ` +
			`Land the rows: the canonical pair lives under benchmarks/ ` +
			`(benchmark.md the top-node summary, benchmarks.json5 the authoritative ` +
			`tree), the legacy root pair stays honored while present — owner ` +
			`directive #47519. Escape hatch: SUSPENDERS_DONE_DOCS=0.`,
	};
};
import { setting } from "@klh/settings";
