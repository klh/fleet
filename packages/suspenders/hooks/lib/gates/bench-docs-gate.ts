// hooks/lib/gates/bench-docs-gate.ts — W951: owner directive #47519. A bench
// landing must carry its ledgers: a bench-shaped item's closing diff
// (the baseline..sha path window) must touch BOTH root ledgers —
// benchmarks.md (the measured result) and doesnt_work.md (what failed) —
// or closure is refused. W949 landed both rows by hand; this gate makes
// the pair mandatory for every bench after it. SUSPENDERS_DONE_DOCS=0
// disables.
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

/** the two root ledgers a bench landing must touch. */
export const BENCH_DOC_PATHS = ["benchmarks.md", "doesnt_work.md"];

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
	if (o.disabled ?? process.env.SUSPENDERS_DONE_DOCS === "0")
		return { ok: true };
	if (!isBenchItem(o.title, o.desc)) return { ok: true };
	const missing = BENCH_DOC_PATHS.filter((p) => !o.paths.includes(p));
	if (!missing.length) return { ok: true };
	return {
		ok: false,
		missing,
		why:
			`bench-docs (W951): the item is bench-shaped (title/description names a bench or A/B) ` +
			`but the closing diff never touches ${missing.join(" + ")}. ` +
			`Land the rows: benchmarks.md carries the measured result, doesnt_work.md the ` +
			`what-didnt-work entry — owner directive #47519. Escape hatch: SUSPENDERS_DONE_DOCS=0.`,
	};
};
