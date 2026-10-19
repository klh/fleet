// Resolve a work item to the recipients a board prompt can address.
// The route is chosen visibly in the UI and checked again at send time.
import type { Database } from "bun:sqlite";

export type OrchRoute = "lane" | "parent" | "supervisor";

export interface OrchTargets {
	id: string;
	project: string;
	parentId: string | null;
	lane: string | null;
	parent: string | null;
	supervisor: string | null;
}

export function orchTargets(
	db: Database,
	project: string,
	id: string,
): OrchTargets | null {
	const row = db
		.query(
			"SELECT owner_sid, parent_id FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, id) as {
		owner_sid: string | null;
		parent_id: string | null;
	} | null;
	if (!row) return null;
	const parent = row.parent_id
		? (db
				.query("SELECT owner_sid FROM work_items WHERE project = ? AND id = ?")
				.get(project, row.parent_id) as { owner_sid: string | null } | null)
		: null;
	const coordinator = db
		.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
		.get() as { value: string } | null;
	return {
		id,
		project,
		parentId: row.parent_id,
		lane: row.owner_sid,
		parent: parent?.owner_sid ?? null,
		supervisor: coordinator?.value ?? null,
	};
}

export function orchRecipient(
	targets: OrchTargets,
	route: OrchRoute,
): string | null {
	return targets[route];
}
