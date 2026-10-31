// hooks/lib/line-limit-exempt.ts — W1300: the explicit vendor-exemption rows
// for the 1500-line law (law.ts-1500-decompose). Upstream-owned vendored
// bytes stay byte-pure (packages/decant/FLEET.md seam): a local split would
// fork the vendor snapshot and conflict on every upstream re-sync, so each
// row pins the file, the why-bun-won't-rewrite argument, and the upstream
// path that reconciles its size. Every ledger face of the law consumes this
// ONE table: the CI guard (tests/law-guards.test.ts) and the merge-ladder
// soft cap (hooks/lib/decomposition.ts — re-syncs never auto-mint a
// contradicting "DRY and decompose" item). The on-write gate
// (hooks/gates/files.ts) deliberately does NOT consult it — blocking edits
// to a byte-pure vendor file is the posture, not a violation. The guard's
// teeth test fails a row whose file is untracked or no longer over the cap:
// stale exemptions are deleted, never accumulated.

export interface LineLimitExemption {
	/** Repo-relative path, exact match. */
	path: string;
	/** Why a local split is wrong (the bun-won't-rewrite argument). */
	why: string;
	/** Where the size reconciles instead (the upstream-sync path). */
	upstream: string;
}

export const LINE_LIMIT_EXEMPT: readonly LineLimitExemption[] = [];
// W2211: the decant ingest.ts row retired — W1238.1/W1238.6.3 decomposed
// the vendored snapshot below the cap (ingest.ts 281 lines; the guard's
// stale-row rule deletes the exemption in the same landing).

/** The exemption row for an exact repo-relative path, else undefined. */
export function lineLimitExemption(
	path: string,
): LineLimitExemption | undefined {
	return LINE_LIMIT_EXEMPT.find((row) => row.path === path);
}
