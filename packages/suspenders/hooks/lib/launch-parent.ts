type QueryStore = {
	query(sql: string): { get(...args: string[]): unknown };
};

/** Parentage is creator provenance, never a guess from nearby active sessions. */
export function launchParent(
	store: QueryStore,
	project: string,
	item: string,
	now = Date.now(),
): string | null {
	const row = store
		.query(
			"SELECT s.sid, s.hb FROM work_items w JOIN sessions s ON s.sid=w.created_by AND s.project=w.project WHERE w.project=? AND w.id=? AND s.state='RUNNING'",
		)
		.get(project, item) as { sid: string; hb: number } | null;
	if (
		!row ||
		!Number.isFinite(row.hb) ||
		now - row.hb > 15 * 60_000 ||
		row.hb > now + 30_000
	)
		return null;
	return row.sid;
}
