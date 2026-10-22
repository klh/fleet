// hooks/lib/work-edit.ts — W1128: `work edit` amends a live work item in
// place — title, description, tags, priority. Owner GO 2026-10-22: the graph
// had no amend surface, so a one-line desc fix forced a supersede chain
// (W1125→W1126→W1127) and a full take→dispatch round trip. Terminal states
// refuse — history stays a ledger; supersede/retry own the dead ends. A
// CLAIMED item still edits (the record is not the lane): the CLI points the
// operator at `coord message <sid>` to steer the live lane.
import type { GovernorStore } from "./govdb.ts";
import { validateTags } from "./work-tags.ts";

// the terminal set: these states own their record — amend via supersede/retry
export const EDIT_REFUSES = new Set([
	"DONE",
	"CANCELLED",
	"SUPERSEDED",
	"FAILED",
]);

export type EditPatch = {
	title?: string;
	desc?: string;
	tag?: string;
	priority?: number;
};

export type EditedField = { from: string | number | null; to: string | number };

export type EditResult =
	| {
			ok: true;
			changed: Record<string, EditedField>;
			state: string;
			owner: string | null;
	  }
	| { ok: false; error: string };

// flag key → work_items column; validated first, one UPDATE applies all
const COLUMNS = {
	title: "title",
	desc: "description",
	tag: "tags",
	priority: "priority",
} as const;

export function editWorkItem(
	store: GovernorStore,
	project: string,
	id: string,
	patch: EditPatch,
): EditResult {
	const given = (Object.keys(COLUMNS) as (keyof EditPatch)[]).filter(
		(k) => patch[k] !== undefined,
	);
	if (given.length === 0)
		return {
			ok: false,
			error: "nothing to amend — give --title, --desc, --tag or --priority",
		};

	return store.transaction(() => {
		const it = store
			.query("SELECT * FROM work_items WHERE project=? AND id=?")
			.get(project, id) as
			| (Record<string, string | number | null> & { state: string })
			| undefined;
		if (!it) return { ok: false, error: `no such work item: ${id}` };
		if (EDIT_REFUSES.has(it.state))
			return {
				ok: false,
				error: `${id} is ${it.state} — terminal; edits refused (supersede or retry instead)`,
			};

		// validate everything BEFORE the UPDATE — a bad tag never half-applies
		let tags: string | null = null;
		if (patch.tag !== undefined) {
			try {
				tags = validateTags(patch.tag);
			} catch (e) {
				return {
					ok: false,
					error: `tag: ${e instanceof Error ? e.message : String(e)}`,
				};
			}
		}
		if (patch.priority !== undefined && !Number.isInteger(patch.priority))
			return {
				ok: false,
				error: `priority: ${patch.priority} — needs an integer`,
			};
		const title = patch.title?.trim();
		if (patch.title !== undefined && title === "")
			return { ok: false, error: "title: needs non-empty content" };

		const sets = ["updated_at = ?"];
		const vals: (string | number)[] = [Date.now()];
		const changed: Record<string, EditedField> = {};
		for (const k of given) {
			const to =
				k === "priority"
					? (patch.priority as number)
					: k === "tag"
						? (tags as string)
						: k === "title"
							? (title as string)
							: (patch.desc as string);
			const col = COLUMNS[k];
			const from = it[col] ?? null;
			if (from === to) continue; // value already current — not a change
			changed[col] = { from, to };
			sets.push(`${col} = ?`);
			vals.push(to);
		}
		if (sets.length === 1)
			return {
				ok: true,
				changed: {},
				state: it.state,
				owner: (it.owner_sid as string | null) ?? null,
			};

		store.run(
			`UPDATE work_items SET ${sets.join(", ")} WHERE project=? AND id=?`,
			...vals,
			project,
			id,
		);
		return {
			ok: true,
			changed,
			state: it.state,
			owner: (it.owner_sid as string | null) ?? null,
		};
	})();
}

// the work.edited payload: flat new values keyed by column, per-field prior
// values beside them (audit without re-reading the row), fields + reason
export function editPayload(
	changed: Record<string, EditedField>,
	reason: string,
): Record<string, string> {
	const payload: Record<string, string> = {
		fields: Object.keys(changed).join(","),
		reason,
	};
	for (const [col, f] of Object.entries(changed)) {
		payload[col] = String(f.to);
		payload[`${col}.was`] = f.from === null ? "" : String(f.from);
	}
	return payload;
}

// CLAIMED pass-through note — the record is updated but the lane keeps riding;
// steering goes through the coord plane, never a supersede
export function editSteer(state: string, owner: string | null): string | null {
	if (state !== "CLAIMED" || !owner) return null;
	return `CLAIMED by ${owner} — record updated; steer the live lane: coord message ${owner} "<what changed>"`;
}
