// fleet-loop/ladder-repair.ts — W2179: the merge ladder's exits. Before this,
// three states were silent dead ends (loop.log 2026-10-27: 153 DONE branches
// deferred forever): a branch conflicting with main surfaced as a review
// error and only ever deferred; a parked branch logged "needs a repair lane"
// and minted nothing; and no DONE branch stuck behind any gate ever reached
// the owner. Each now has one exit: conflicts strike and mint a rebase item,
// parking mints a repair item, and a stuck DONE branch raises NEED_DECISION.

import { readFileSync, writeFileSync } from "node:fs";
import {
	type GovernorStore,
	openStore,
	projectIdentity,
} from "../govdb/govdb.ts";
import { enqueueWorkItem } from "../work/work-enqueue.ts";

export type RepairOptions = {
	db?: GovernorStore;
	enqueue?: (title: string, description: string) => string | null;
};

const OPEN_STATE = "state NOT IN ('DONE', 'CANCELLED', 'SUPERSEDED')";

/** The review context builds a merge preview with `git merge-tree
 * --write-tree`, which exits non-zero on a content conflict — that error is
 * a conflict with main, not a review problem. */
export const isConflictWhy = (why: string): boolean =>
	/git merge-tree failed|candidate merge conflicts/.test(why);

/** One open repair item per original branch: both titles carry ` <branch> `
 * (space-delimited, so W1.1 never matches W1.10). Returns the open item's id
 * or the freshly minted one; null when the work CLI refused. */
export function ensureRepairItem(
	repo: string,
	branch: string,
	kind: "rebase" | "repair",
	detail: string,
	options: RepairOptions = {},
): { id: string | null; minted: boolean } {
	const db = options.db ?? openStore();
	try {
		const open = db
			.query(
				`SELECT id FROM work_items WHERE project = ? AND (title LIKE ? OR title LIKE ?) AND ${OPEN_STATE} LIMIT 1`,
			)
			.get(
				projectIdentity(repo),
				`rebase ${branch} %`,
				`repair ${branch} %`,
			) as { id: string } | null;
		if (open) return { id: open.id, minted: false };
	} finally {
		if (!options.db) db.close();
	}
	const title =
		kind === "rebase"
			? `rebase ${branch} onto main (merge ladder conflict)`
			: `repair ${branch} (parked by the merge ladder)`;
	const description = [
		`The merge ladder cannot land ${branch}: ${detail}.`,
		`Merge refs/heads/${branch} (or its parked/ rename) into this item's branch, resolve every conflict against current main, run the touched suites, and close this item — its branch lands through the ladder in place of the original.`,
	].join("\n");
	const id = options.enqueue
		? options.enqueue(title, description)
		: enqueueWorkItem(repo, "fleet-loop", title, description);
	return { id, minted: id !== null };
}

export type StuckOptions = {
	file: string;
	now?: number;
	/** age before the alarm; SUSPENDERS_MERGE_STUCK_HOURS, default 6 */
	maxAgeMs?: number;
	db?: GovernorStore;
};

type StuckRow = { since: number; why: string; raised?: boolean };

const readStuck = (file: string): Record<string, StuckRow> => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, StuckRow>;
	} catch {
		return {};
	}
};

export const stuckMaxAgeMs = (): number => {
	const hours = Number(process.env.SUSPENDERS_MERGE_STUCK_HOURS);
	return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000;
};

/** Record a DONE branch's deferral; raise NEED_DECISION once when it has been
 * deferred longer than the max age. Returns true on the cycle that raised. */
export function noteStuckDefer(
	repo: string,
	branch: string,
	item: string,
	why: string,
	options: StuckOptions,
): boolean {
	const now = options.now ?? Date.now();
	const rows = readStuck(options.file);
	const row = rows[branch] ?? { since: now, why };
	row.why = why;
	rows[branch] = row;
	const due =
		!row.raised && now - row.since >= (options.maxAgeMs ?? stuckMaxAgeMs());
	if (due) {
		const db = options.db ?? openStore();
		try {
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', 'NEED_DECISION', ?, ?, NULL)",
			).run(
				now,
				branch,
				JSON.stringify({
					project: projectIdentity(repo),
					item,
					note: `${item} is DONE but ${branch} has not merged for ${Math.round((now - row.since) / 3_600_000)}h: ${why}`,
				}),
			);
			row.raised = true;
		} finally {
			if (!options.db) db.close();
		}
	}
	try {
		writeFileSync(options.file, JSON.stringify(rows));
	} catch {}
	return due;
}

/** Forget a branch once it merged, retired or was parked. */
export function clearStuck(file: string, branch: string): void {
	const rows = readStuck(file);
	if (rows[branch] === undefined) return;
	delete rows[branch];
	try {
		writeFileSync(file, JSON.stringify(rows));
	} catch {}
}
