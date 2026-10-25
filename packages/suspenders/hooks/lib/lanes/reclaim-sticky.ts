// reclaim-sticky.ts — W831: reclaim reason discriminator + sticky-until-resume
// marker (Chorus control-handler lift). A reclaim records WHY the claim died
// (user = operator-initiated, crash = automation-detected death); the marker
// is sticky — only the next successful claim (resume) clears it. No sweep
// re-arms or removes it, so a reclaimed item converges instead of dangling.
// The gate helper encodes the double-check: a user reclaim refuses a
// verifiably-alive claimant unless explicitly forced; a crash reclaim holds
// itself to the bulk-pass standard (positive death evidence required).
import type { GovernorStore } from "../govdb/govdb.ts";

export type ReclaimReason = "user" | "crash";

export type ReclaimMarker = {
	reason: ReclaimReason;
	from: string | null;
	at: number;
};

// facts key is globally unique — project + item namespace it (reclaim-liveness
// parity: reclaim.strike.<project>.<id>).
const markerKey = (project: string, id: string): string =>
	`reclaim.reason.${project}.${id}`;

export const parseReclaimReason = (
	raw: string | undefined,
): ReclaimReason | null => (raw === "user" || raw === "crash" ? raw : null);

/** Sticky marker write — idempotent (latest wins), never re-armed by sweeps. */
export function markReclaimed(
	store: GovernorStore,
	project: string,
	id: string,
	reason: ReclaimReason,
	from: string | null,
): void {
	store.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'work', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		markerKey(project, id),
		JSON.stringify({ reason, from, at: Date.now() } satisfies ReclaimMarker),
		Date.now(),
	);
}

export function readReclaimMarker(
	store: GovernorStore,
	project: string,
	id: string,
): ReclaimMarker | null {
	try {
		const row = store
			.query("SELECT value FROM facts WHERE key = ?")
			.get(markerKey(project, id)) as { value: string } | null;
		if (!row) return null;
		const v = JSON.parse(row.value) as Partial<ReclaimMarker>;
		return v.reason === "user" || v.reason === "crash"
			? { reason: v.reason, from: v.from ?? null, at: v.at ?? 0 }
			: null;
	} catch {
		return null;
	}
}

/** Resume convergence: the next successful claim clears the marker. */
export function clearReclaimMarker(
	store: GovernorStore,
	project: string,
	id: string,
): void {
	try {
		store.run("DELETE FROM facts WHERE key = ?", markerKey(project, id));
	} catch {}
}

/** The reclaim double-check, as a total decision over (verdict, reason, force).
 * dead → proceed; unknown → proceed (the attended per-item path; the bulk pass
 * keeps the strict standard); alive → refuse unless forced. A crash reason
 * claims automation-detected death, so it demands positive death evidence. */
export function reclaimGateDecision(
	verdict: "alive" | "dead" | "unknown",
	reason: ReclaimReason,
	force: boolean,
): { ok: boolean; why: string } {
	if (reason === "crash") {
		return verdict === "dead"
			? { ok: true, why: "claimant verifiably dead (crash reclaim)" }
			: {
					ok: false,
					why: `claimant liveness is ${verdict}, not verifiably dead — crash reclaims demand death evidence`,
				};
	}
	if (verdict !== "alive")
		return { ok: true, why: `claimant ${verdict} — operator reclaim proceeds` };
	if (force)
		return { ok: true, why: "claimant live — forced operator reclaim" };
	return {
		ok: false,
		why: "claimant lane is live — reclaim would ghost its claim; signal the lane or use --force",
	};
}
