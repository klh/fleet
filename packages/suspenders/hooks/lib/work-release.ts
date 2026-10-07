import type { GovernorStore } from "./govdb.ts";

export type ExpectedWorkClaim = {
	project: string;
	id: string;
	owner: string | null;
	state: string;
	updatedAt: number;
};

/** Release an observed claim, never whichever owner happens to exist later.
 * The authoritative transaction couples CAS, claim cleanup and audit receipt. */
export function releaseWorkClaim(
	store: GovernorStore,
	expected: ExpectedWorkClaim,
	audit: {
		by: string;
		reason: "owner-release" | "operator-reclaim" | "reclaim-all";
	},
	guard?: () => boolean,
): boolean {
	if (!["CLAIMED", "RUNNING", "ORPHANED"].includes(expected.state))
		return false;
	return store.transaction(() => {
		if (guard && !guard()) return false;
		const now = Math.max(Date.now(), expected.updatedAt + 1);
		const changed = store
			.query(
				"UPDATE work_items SET state='READY',owner_sid=NULL,updated_at=? WHERE project=? AND id=? AND owner_sid IS ? AND state=? AND updated_at=?",
			)
			.run(
				now,
				expected.project,
				expected.id,
				expected.owner,
				expected.state,
				expected.updatedAt,
			);
		if (!changed.changes) return false;
		const row = store
			.query("SELECT scope FROM work_items WHERE project=? AND id=?")
			.get(expected.project, expected.id) as { scope: string | null };
		if (expected.owner)
			store
				.query(`DELETE FROM claims WHERE sid=? AND (
			(scope IS ? AND intent='work-graph' AND NOT EXISTS (
				SELECT 1 FROM work_items WHERE owner_sid=? AND scope IS ? AND state IN ('CLAIMED','RUNNING','ORPHANED')
			)) OR (substr(intent,1,length(?)+1)=? || ' ' AND NOT EXISTS (
				SELECT 1 FROM work_items WHERE owner_sid=? AND id=? AND state IN ('CLAIMED','RUNNING','ORPHANED')
			))
		)`)
				.run(
					expected.owner,
					row.scope,
					expected.owner,
					row.scope,
					expected.id,
					expected.id,
					expected.owner,
					expected.id,
				);
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'work','work.released',?,?,NULL)",
			)
			.run(
				now,
				row.scope,
				JSON.stringify({
					work: expected.id,
					project: expected.project,
					by: audit.by,
					reason: audit.reason,
				}),
			);
		return true;
	})();
}
