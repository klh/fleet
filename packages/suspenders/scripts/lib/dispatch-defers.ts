// scripts/lib/dispatch-defers.ts — W1145: item-local dispatch deferrals.
// dispatchItem's null returns split two classes: item-local deferrals (the
// item's own tree/claim/brief state — residue guards, claimed-elsewhere,
// create failure, brief refusal) and global holds (provider walls, host
// pressure, live/unknown guards, launch failures). The plaid refill loop
// stops on global holds only; an item-local deferral lets the remaining
// READY pool proceed. The guards themselves are untouched: residue is never
// discarded, the item still refuses its own spawn — other items just stop
// losing their turn to it.
const deferred: string[] = [];
/** Record an item-local deferral; returns null so call sites read
 *  `return deferItem(item);` at the existing SKIP exits. */
export const deferItem = (item: string): null => {
	deferred.push(item);
	return null;
};
/** true when this dispatch run deferred the item for an item-local reason. */
export const isDeferredItem = (item: string): boolean =>
	deferred.includes(item);
