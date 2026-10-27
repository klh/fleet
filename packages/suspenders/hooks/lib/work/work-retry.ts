// hooks/lib/work/work-retry.ts — W761: FAILED is a ledger dead-end without a
// recovery verb — one bad environment window (2026-10-15 fence bug) poisoned
// 13 items and the coordinator hand-rolled supersede re-mints for every one.
// retry = the inverse of `fail` for environment-killed work: FAILED → READY,
// stale claim rows released, launch budget reset so the next dispatch gets a
// fresh attempt count. Superseded/DONE/CANCELLED stay closed — retry never
// rewrites history; it only re-opens work the environment killed.
import { launchSchema } from "../../../scripts/lib/launch-fencing.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import { budgetFlagClear } from "../usage/budget-flag.ts";
import {
	COMPLETION_LOOKUP_UNAVAILABLE,
	CompletionLookupUnavailableError,
	type ReactivationRefusal,
	reactivationRefusal,
} from "./work-completion-record.ts";

type Row = {
	state: string;
	owner_sid: string | null;
	scope: string | null;
};

function releaseStaleClaims(store: GovernorStore, row: Row, id: string): void {
	if (!row.owner_sid) return;
	store.run(
		"DELETE FROM claims WHERE sid = ? AND (scope = ? OR (? IS NOT NULL AND intent LIKE ? || ' %'))",
		row.owner_sid,
		row.scope,
		id,
		id,
	);
}

export function retryFailedItem(
	store: GovernorStore,
	project: string,
	id: string,
): { ok: boolean; error?: string; code?: string } {
	return store.transaction(() => {
		const it = store
			.query("SELECT * FROM work_items WHERE project=? AND id=?")
			.get(project, id) as Row | undefined;
		if (!it) return { ok: false, error: `no such work item: ${id}` };
		// W1173: a retained completion record is completed history — retry is
		// the reactivation gate and refuses with the deterministic diagnostic.
		// W1173.1.1: when the gate's lookup cannot prove absence (store
		// unavailable, transient failure) the refusal propagates in the
		// established shape instead of reading as "no record".
		let reactivation: ReactivationRefusal | null;
		try {
			reactivation = reactivationRefusal(store, project, id);
		} catch (e) {
			if (e instanceof CompletionLookupUnavailableError)
				return {
					ok: false,
					error: e.message,
					code: COMPLETION_LOOKUP_UNAVAILABLE,
				};
			throw e;
		}
		if (reactivation)
			return {
				ok: false,
				error: reactivation.message,
				code: reactivation.code,
			};
		if (it.state !== "FAILED") {
			// W787: a READY item with a launch-budget reservation is the same
			// environment-killed class — dispatch refuses it every cycle (and
			// that refusal was the NEED_DECISION flood). Retry resets it too.
			launchSchema(store);
			const quarantined = store
				.query("SELECT 1 FROM lane_launch_budgets WHERE project=? AND item=?")
				.get(project, id);
			if (it.state !== "READY")
				return {
					ok: false,
					error: `${id} is ${it.state} — only FAILED items (or budget-quarantined READY) retry`,
				};
			if (!quarantined)
				return {
					ok: false,
					error: `${id} is READY with no launch-budget reservation — nothing to retry`,
				};
		}
		releaseStaleClaims(store, it, id);
		store.run(
			"UPDATE work_items SET state='READY', owner_sid=NULL, updated_at=? WHERE project=? AND id=?",
			Date.now(),
			project,
			id,
		);
		launchSchema(store);
		store.run(
			"DELETE FROM lane_launch_budgets WHERE project=? AND item=?",
			project,
			id,
		);
		// W787/W782.4: drain the open budget decision — a future exhaustion
		// re-flags (one NEED_DECISION per exhaustion episode, not per cycle).
		budgetFlagClear(store, id);
		return { ok: true };
	})();
}
