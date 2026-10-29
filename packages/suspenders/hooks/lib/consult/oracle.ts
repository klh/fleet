// hooks/lib/consult/oracle.ts — hub design phase 4: ORACLE FIRST. Every
// consult asks the knowledge store before any delivery; a hit that may
// answer is answered by the plane (consult.answered_by = knowledge) and no
// lane is interrupted.
//
// Who may answer (owner decision 2026-10-29):
//   active + hash verified        → trusted
//   candidate, hash not drifted   → unreviewed (the reply says so)
//   drift / retired / rejected    → never answers; normal delivery
//   demoted by downvotes          → never answers (knowledge-votes.ts)
// Ranking stays active > candidate (D9): any trusted hit beats any
// unreviewed one, overlap only orders within a tier.
//
// Every knowledge answer carries a visible trust mark AND the feedback
// handle — the asker is obliged to report resolved|failed (owner refinement).

export type OracleTier = "trusted" | "unreviewed";

export interface OracleHitShape {
	kind?: string;
	id?: number;
	state?: string | null;
	trust?: "verified" | "drift" | "unverified";
	hop?: number;
}

export function oracleEligibility(h: OracleHitShape): OracleTier | null {
	if (h.kind !== "knowledge" || h.hop) return null;
	if (h.trust === "drift") return null;
	const state = h.state ?? "active"; // pre-state rows read as canon
	if (state === "active") return h.trust === "verified" ? "trusted" : null;
	if (state === "candidate") return "unreviewed";
	return null; // retired, rejected, superseded, …
}

const TIER_RANK: Record<OracleTier, number> = { trusted: 2, unreviewed: 1 };

/** active > candidate first, overlap second. */
export function outranks(
	a: { tier: OracleTier; overlap: number },
	b: { tier: OracleTier; overlap: number } | null,
): boolean {
	if (!b) return true;
	if (TIER_RANK[a.tier] !== TIER_RANK[b.tier])
		return TIER_RANK[a.tier] > TIER_RANK[b.tier];
	return a.overlap > b.overlap;
}

export function feedbackHandle(cid: string): string {
	return `report: coord consult-reply ${cid} --feedback resolved|failed --evidence "..."`;
}

/** The visible mark every knowledge-sourced answer carries. */
export function answerMark(
	tier: OracleTier,
	hit: OracleHitShape,
	cid: string,
): string {
	const trust =
		tier === "unreviewed"
			? `candidate · unreviewed · hash ${hit.trust ?? "unverified"}`
			: "active · hash verified";
	return `trust: ${trust} · entry k#${hit.id ?? "?"} · ${feedbackHandle(cid)}`;
}
