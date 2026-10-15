// hooks/lib/work-retry.ts — W761: FAILED is a ledger dead-end without a
// recovery verb — one bad environment window (2026-10-15 fence bug) poisoned
// 13 items and the coordinator hand-rolled supersede re-mints for every one.
// retry = the inverse of `fail` for environment-killed work: FAILED → READY,
// stale claim rows released, launch budget reset so the next dispatch gets a
// fresh attempt count. Superseded/DONE/CANCELLED stay closed — retry never
// rewrites history; it only re-opens work the environment killed.
import { launchSchema } from "../../scripts/lib/launch-fencing.ts";
import type { GovernorStore } from "./govdb.ts";

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
): { ok: boolean; error?: string } {
	return store.transaction(() => {
		const it = store
			.query("SELECT * FROM work_items WHERE project=? AND id=?")
			.get(project, id) as Row | undefined;
		if (!it) return { ok: false, error: `no such work item: ${id}` };
		if (it.state !== "FAILED") {
			return {
				ok: false,
				error: `${id} is ${it.state} — only FAILED items retry`,
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
		return { ok: true };
	})();
}
