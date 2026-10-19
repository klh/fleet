// verdict-repeat.ts — W896: the dispatch plane's repeat-verdict breaker.
// W552 (2026-10-19): a lane closed every attempt on the same verdict line
// ("parent operator-gated - nothing new"); dispatch kept re-spawning it
// because the graph only ever saw CLAIMED/FAILED churn. On the resume path
// the capsule already stores the prior verdict (its done text) — compare it
// with the observation this plane banked at the LAST dispatch cycle, and
// gate only on a verbatim repeat from a RE-BANKED capsule (ts advanced): a
// blind crash that never re-banked keeps its normal resume. The pure
// decision core + the gate live here; dispatch-next.ts injects the plane's
// CLI helpers and owns the worktree/spawn path.
export interface VerdictObservation {
	verdict: string;
	ts: number;
}

/** The capsule's closing verdict: its done text, trimmed. Empty = none. */
export const verdictOfCapsule = (
	capsule: Record<string, unknown> | null,
): string => (typeof capsule?.done === "string" ? capsule.done.trim() : "");

export const capsuleBankedAt = (
	capsule: Record<string, unknown> | null,
): number => Number(capsule?.ts ?? 0) || 0;

/** `coord fact get lane.<id>.verdict-last` stdout → the stored observation
 *  (first line; the fact CLI appends ` (vN)`), null when unset or corrupt. */
export const parseVerdictObservation = (
	factOut: string,
): VerdictObservation | null => {
	const line = (factOut.split("\n")[0] ?? "").replace(/\s*\(v\d+\)$/, "");
	if (!line || line === "(unset)") return null;
	try {
		const o = JSON.parse(line) as Partial<VerdictObservation>;
		if (typeof o.verdict !== "string") return null;
		return { verdict: o.verdict, ts: Number(o.ts ?? 0) || 0 };
	} catch {
		return null;
	}
};

/** THE one comparison: gate only when the current close is a verbatim
 *  verdict repeat AND the capsule was re-banked (ts advanced) — identical
 *  text on an unchanged capsule is a crash that never closed, not a
 *  verdict. */
export const verdictRepeats = (
	stored: VerdictObservation | null,
	verdict: string,
	ts: number,
): boolean =>
	stored !== null &&
	stored.ts > 0 &&
	ts > stored.ts &&
	verdict.length > 0 &&
	stored.verdict === verdict;
