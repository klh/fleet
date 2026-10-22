// scripts/lib/dispatch-defers.ts — W1145: item-local dispatch deferrals.
// dispatchItem's null returns split two classes: item-local deferrals (the
// item's own tree/claim/brief state — residue guards, claimed-elsewhere,
// brief refusal) and global holds (unclassified create failure, provider walls, host
// pressure, live/unknown guards, launch failures). The plaid refill loop
// stops on global holds only; an item-local deferral lets the remaining
// READY pool proceed. The guards themselves are untouched: residue is never
// discarded, the item still refuses its own spawn — other items just stop
// losing their turn to it.
import { isResumableClaim } from "./resumable-claim.ts";

const deferred: string[] = [];
/** Record an item-local deferral; returns null so call sites read
 *  `return deferItem(item);` at the existing SKIP exits. */
export const deferItem = (
	item: string,
	evidence?: { code: number; out: string },
	sid?: string,
): null => {
	// A failed command/unreadable row is a global unknown, not proof of contention.
	if (evidence !== undefined) {
		if (evidence.code !== 0 || !sid) return null;
		try {
			const row: unknown = JSON.parse(evidence.out);
			const owner =
				row && typeof row === "object"
					? (row as Record<string, unknown>).owner_sid
					: null;
			if (
				typeof owner !== "string" ||
				!owner.trim() ||
				owner === sid ||
				!isResumableClaim(evidence.out, item, owner)
			)
				return null;
		} catch {
			return null;
		}
	}
	deferred.push(item);
	return null;
};
/** true when this dispatch run deferred the item for an item-local reason. */
export const isDeferredItem = (item: string): boolean =>
	deferred.includes(item);
