/** W2955: trigger dedup for the review crank.
 *
 * W2946 fixed review VALIDITY across base moves (shared-input root-scoping);
 * the remaining dual-work spend is re-INVOCATION: every label event re-keys
 * the request (the key hashes commit+base+instructions), so a landing wave
 * fires a fresh model leg per event while the previous leg is still live.
 *
 * The guard: at most ONE live review per (branch, label-event) — a second
 * admission for the same (project, item) while another key holds an
 * unexpired RUNNING lease refuses and rides the existing receipt. Legacy
 * rows (no item/project stamp) are invisible to the probe — the guard
 * degrades to the pre-W2955 behavior rather than refusing blindly.
 */
import type { GovernorStore } from "../govdb/govdb-store.ts";

/** The live leg holding the (project, item) key, if any other key does. */
export function liveReviewLeg(
	db: GovernorStore,
	project: string,
	item: string,
	key: string,
	now: number,
): { key: string; leaseUntil: number } | null {
	const row = db
		.query(
			"SELECT key, json_extract(value, '$.leaseUntil') AS leaseUntil FROM facts WHERE source = 'review-scheduler' AND key <> ? AND json_extract(value, '$.state') = 'RUNNING' AND json_extract(value, '$.leaseUntil') > ? AND json_extract(value, '$.project') = ? AND json_extract(value, '$.item') = ? ORDER BY json_extract(value, '$.leaseUntil') DESC LIMIT 1",
		)
		.get(key, now, project, item) as {
		key: string;
		leaseUntil: number;
	} | null;
	return row && typeof row.leaseUntil === "number" ? row : null;
}

/** The admission refusal text — one live review per branch, the later event
 * rides the live leg's receipt instead of spending a fresh model leg. */
export const liveReviewRefusal = (
	item: string,
	leg: { key: string; leaseUntil: number },
): string =>
	`review already live for ${item} on another label-event (${leg.key}, lease expires ${new Date(
		leg.leaseUntil,
	).toISOString()}) — riding that receipt (W2955 trigger dedup)`;
