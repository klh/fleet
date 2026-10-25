// hooks/lib/usage/budget-flag.ts — W782.4: one open budget-exhaustion
// NEED_DECISION per item. The launcher raises the decision ONCE per episode:
// the `lane.budget-flagged.<item>` fact gates both the launch- and the
// resume-budget emitters (dispatch-next) — later cycles in the same episode
// log a suppression instead of re-emitting into the decision feed. Drained
// when the item leaves the class: `work retry` (resets the launch budget too,
// W787) and `work done`. W787 put the flag on the launch path only; W782.4
// lifts it into this one shared throttle.
import type { GovernorStore } from "../govdb/govdb.ts";

export const budgetFlagKey = (item: string): string =>
	`lane.budget-flagged.${item}`;

/** The open episode's ISO stamp, or undefined when nothing is flagged. */
export function budgetFlagGet(
	store: GovernorStore,
	item: string,
): string | undefined {
	const row = store
		.query("SELECT value FROM facts WHERE key=?")
		.get(budgetFlagKey(item)) as { value: string } | undefined;
	return row?.value;
}

/** Claim this episode's NEED_DECISION: true → caller emits (flag raised);
 *  false → an open decision already stands, suppress. */
export function budgetFlagClaim(store: GovernorStore, item: string): boolean {
	if (budgetFlagGet(store, item) !== undefined) return false;
	store
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'dispatch',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=version+1,ts=excluded.ts",
		)
		.run(budgetFlagKey(item), new Date().toISOString(), Date.now());
	return true;
}

/** Drain: the item left the budget-flagged class — the next exhaustion
 *  raises a fresh decision. */
export function budgetFlagClear(store: GovernorStore, item: string): void {
	store.run("DELETE FROM facts WHERE key=?", budgetFlagKey(item));
}
