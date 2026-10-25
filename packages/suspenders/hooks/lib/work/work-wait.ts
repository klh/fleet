// External prerequisites are durable Work Graph state. An elapsed timestamp
// never wakes an item automatically: an operator must verify the prerequisite.
import { launchSchema } from "../../../scripts/lib/launch-fencing.ts";
import { budgetFlagClear } from "../usage/budget-flag.ts";
import type { GovernorStore } from "../govdb/govdb.ts";

export const WAIT_KINDS = [
	"quota",
	"credentials",
	"operator",
	"dependency",
	"external",
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

type Row = {
	state: string;
	owner_sid: string | null;
	scope: string | null;
	wait_until: number | null;
};
type Result = { ok: boolean; error?: string };

export function parseWaitUntil(
	value: string | null | undefined,
): number | null {
	if (value == null) return null;
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value))
		throw new Error("--until must be an ISO-8601 date-time with timezone");
	const at = Date.parse(value);
	if (!Number.isFinite(at) || !/(Z|[+-]\d\d:\d\d)$/.test(value))
		throw new Error("--until must be an ISO-8601 date-time with timezone");
	return at;
}

export function waitForPrerequisite(
	store: GovernorStore,
	project: string,
	id: string,
	kind: string,
	reason: string,
	until: number | null,
): Result {
	if (!WAIT_KINDS.includes(kind as WaitKind))
		return { ok: false, error: `unknown waiting kind: ${kind}` };
	if (!reason.trim()) return { ok: false, error: "waiting reason is required" };
	return store.transaction(() => {
		const row = store
			.query(
				"SELECT state, owner_sid, scope, wait_until FROM work_items WHERE project=? AND id=?",
			)
			.get(project, id) as Row | undefined;
		if (!row) return { ok: false, error: `no such work item: ${id}` };
		if (!["READY", "FAILED", "WAITING"].includes(row.state))
			return {
				ok: false,
				error: `${id} is ${row.state}; release an active claim before waiting`,
			};
		if (row.owner_sid)
			store.run(
				"DELETE FROM claims WHERE sid=? AND (scope=? OR (? IS NOT NULL AND intent LIKE ? || ' %'))",
				row.owner_sid,
				row.scope,
				id,
				id,
			);
		store.run(
			"UPDATE work_items SET state='WAITING', owner_sid=NULL, wait_kind=?, wait_reason=?, wait_until=?, updated_at=? WHERE project=? AND id=?",
			kind,
			reason.trim(),
			until,
			Date.now(),
			project,
			id,
		);
		return { ok: true };
	})();
}

export function wakeAfterEvidence(
	store: GovernorStore,
	project: string,
	id: string,
	note: string,
	force = false,
): Result {
	if (!note.trim()) return { ok: false, error: "wake evidence is required" };
	return store.transaction(() => {
		const row = store
			.query(
				"SELECT state, wait_until FROM work_items WHERE project=? AND id=?",
			)
			.get(project, id) as Pick<Row, "state" | "wait_until"> | undefined;
		if (!row) return { ok: false, error: `no such work item: ${id}` };
		if (row.state !== "WAITING")
			return {
				ok: false,
				error: `${id} is ${row.state}; only WAITING items wake`,
			};
		if (row.wait_until && Date.now() < row.wait_until && !force)
			return {
				ok: false,
				error: `${id} waits until ${new Date(row.wait_until).toISOString()}; use --force with evidence to wake early`,
			};
		store.run(
			"UPDATE work_items SET state='READY', wait_kind=NULL, wait_reason=NULL, wait_until=NULL, updated_at=? WHERE project=? AND id=?",
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
		budgetFlagClear(store, id);
		return { ok: true };
	})();
}
