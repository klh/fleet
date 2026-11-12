// fleet-loop/ladder-repair.ts — W2179: the merge ladder's exits. Before this,
// three states were silent dead ends (loop.log 2026-10-27: 153 DONE branches
// deferred forever): a branch conflicting with main surfaced as a review
// error and only ever deferred; a parked branch logged "needs a repair lane"
// and minted nothing; and no DONE branch stuck behind any gate ever reached
// the owner. Each now has one exit: conflicts strike and mint a rebase item,
// parking mints a repair item, and a stuck DONE branch raises NEED_DECISION.

import { readFileSync, writeFileSync } from "node:fs";
import { providerPressureOf } from "../gates/review-scheduler.ts";
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

type StuckRow = {
	since: number;
	first?: number;
	why: string;
	raised?: boolean;
};

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

/** W2978: transport-stalled defers slide the 6h window, so the backstop is
 * measured from FIRST deferral (immutable), not the sliding edge — a stall
 * that never heals still escalates after 48h total. Not a knob: two days of
 * silent no-progress is a defect in any transport state. */
const STUCK_BACKSTOP_MS = 48 * 3_600_000;

/** Record a DONE branch's deferral; raise NEED_DECISION once when it has been
 * deferred longer than the max age. W2978: a due raise consults the review
 * transport's provider-pressure state first — a transport stall (pressure
 * pause or canary probe in flight) is self-healing, so the branch's window
 * slides (since = now) instead of paging the owner; the absolute
 * STUCK_BACKSTOP_MS (from the immutable first-seen) still escalates a stall
 * that never heals. Returns true on the cycle that raised. */
export function noteStuckDefer(
	repo: string,
	branch: string,
	item: string,
	why: string,
	options: StuckOptions,
): boolean {
	const now = options.now ?? Date.now();
	const rows = readStuck(options.file);
	const row = rows[branch] ?? { since: now, first: now, why };
	row.first ??= row.since;
	row.why = why;
	rows[branch] = row;
	const maxAge = options.maxAgeMs ?? stuckMaxAgeMs();
	const totalAge = now - (row.first ?? row.since);
	const due =
		(!row.raised && now - row.since >= maxAge) ||
		(!row.raised && totalAge >= STUCK_BACKSTOP_MS);
	let raised = false;
	if (due) {
		const db = options.db ?? openStore();
		try {
			// W2978: a review-transport stall (provider-pressure pause or canary
			// probe in flight) is self-healing — the loop re-probes and the
			// review completes once pressure clears; paging the owner mid-stall
			// is noise (W2949 paged exactly this). Slide the window instead of
			// raising; STUCK_BACKSTOP_MS bounds the silence for a stall that
			// never heals.
			const pressure = providerPressureOf(db);
			const stalled =
				pressure.openUntil > now ||
				(pressure.probe !== undefined && pressure.probe.until > now);
			if (stalled && now - (row.first ?? row.since) < STUCK_BACKSTOP_MS) {
				row.since = now;
			} else {
				db.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', 'NEED_DECISION', ?, ?, NULL)",
				).run(
					now,
					branch,
					JSON.stringify({
						project: projectIdentity(repo),
						item,
						note: `${item} is DONE but ${branch} has not merged for ${Math.round(totalAge / 3_600_000)}h: ${why}`,
					}),
				);
				row.raised = true;
				raised = true;
			}
		} finally {
			if (!options.db) db.close();
		}
	}
	try {
		writeFileSync(options.file, JSON.stringify(rows));
	} catch {}
	return raised;
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
