// lane-context.ts — the lane's activation context file:
// .fleet/lane-context.json in the lane's worktree ({ sid, item, baseline,
// launchedAt }), written by dispatch at spawn. W628: `work split --keep` is a
// claim TRANSFER — the keeping lane's context must follow the claim, so the
// rebind runs inside the same transaction as the shatter (a failed rewrite
// rolls the shatter back). Pre-fix splits left the context bound to the
// SHATTERED parent and the W621.1 lane had to hand-edit its own context to
// close.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";
import { projectIdentity } from "../govdb/govdb-project.ts";
import { resolveItemWorktree } from "../work/worktree-lookup.ts";

export interface LaneActivationContext {
	sid: string;
	item: string;
	baseline?: string;
	launchedAt?: number;
}

export const laneContextFile = (dir: string): string =>
	join(dir, ".fleet", "lane-context.json");

/** Parsed context, or null when absent/corrupt. A corrupt file is
 * completion-time's hard error, never split's to overwrite blind. */
export function readLaneContextFile(dir: string): LaneActivationContext | null {
	const path = laneContextFile(dir);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LaneActivationContext;
	} catch {
		return null;
	}
}

/** Rebind one context file to the kept child. Only a context bound to exactly
 * (sid, fromItem) is rewritten — foreign, already-rebound or corrupt contexts
 * are left untouched. Returns toItem on a rewrite, else null. */
export function rebindLaneContext(
	dir: string,
	sid: string,
	fromItem: string,
	toItem: string,
): string | null {
	const context = readLaneContextFile(dir);
	if (!context || context.sid !== sid || context.item !== fromItem) return null;
	writeFileSync(
		laneContextFile(dir),
		JSON.stringify({ ...context, item: toItem }),
	);
	return toItem;
}

/** Candidate dirs holding the keeping lane's context, most-likely first: the
 * splitter's cwd (the split runs from the lane's own worktree), the splitting
 * item's own registered tree, then SHATTERED ancestors' trees (W3009 round-2:
 * chained splits — the splitting item itself is treeless, the carrier sits
 * further up the chain). Deduped. `db` is the CALLER'S already-open store —
 * opening a second one here would hit SQLITE_BUSY under split's write tx
 * (the open ladder writes; measured 10s busy-timeout then throw). */
export function keptLaneContextDirs(
	cwd: string,
	root: string,
	parentItem: string,
	db?: GovernorStore,
): string[] {
	const out: string[] = [];
	for (const dir of [cwd, resolveItemWorktree(root, parentItem)]) {
		if (dir && !out.includes(dir)) out.push(dir);
	}
	if (out.length < 2 && db) {
		// own tree missed — walk the SHATTERED chain for a carrier. Candidate
		// discovery only: the gate-side SHATTERED check enforces correctness, so
		// an unreachable graph degrades to the legacy cwd/own-tree shape.
		try {
			const project = projectIdentity(root);
			let cur =
				(
					db
						.query(
							"SELECT parent_id FROM work_items WHERE project = ? AND id = ?",
						)
						.get(project, parentItem) as { parent_id: string | null } | null
				)?.parent_id ?? null;
			for (let depth = 0; cur && depth < 8; depth++) {
				const row = db
					.query(
						"SELECT state, parent_id FROM work_items WHERE project = ? AND id = ?",
					)
					.get(project, cur) as {
					state: string;
					parent_id: string | null;
				} | null;
				if (row?.state !== "SHATTERED") break;
				const w = resolveItemWorktree(root, cur);
				if (w && !out.includes(w)) out.push(w);
				cur = row.parent_id;
			}
		} catch {
			// registry/graph unavailable → legacy candidates only
		}
	}
	return out;
}

/** W628: rebind the keeping lane's context to the kept child, trying each
 * candidate dir. Called inside split's transaction — a thrown rewrite rolls
 * the shatter back with it. Returns toItem when some candidate's context was
 * rebound, else null.
 *
 * W3009 round-2 (root B review): a manual split (`work take` + `work split`
 * by hand — take never mints a context, only dispatch does) has NO context to
 * rebind, which left the kept binding to a graph-row owner inference the
 * round-2 gate no longer trusts. Persist half: mint the kept binding into
 * the ONE carrier tree (the splitting item's own registered tree, else the
 * first SHATTERED ancestor's tree — the same candidate list the gate checks),
 * never clobbering an existing context. A thrown mint rolls the shatter back
 * with it.
 *
 * Round-4 (root #123980): the carrier is chosen by REGISTERED GRAPH identity
 * — the splitting item's own tree, else the first SHATTERED ancestor's tree —
 * never by cwd inequality: a split run FROM the carrier tree (cwd == carrier)
 * still mints. Round-5 (root #123982): the mint writes only into an ABSENT
 * file — an existing foreign context is preserved; a corrupt file refuses the
 * mint explicitly (the split rolls back with the throw). */
export function rebindKeptLaneContext(
	cwd: string,
	root: string,
	parentItem: string,
	sid: string,
	toItem: string,
	db?: GovernorStore,
): string | null {
	const dirs = keptLaneContextDirs(cwd, root, parentItem, db);
	for (const dir of dirs)
		if (rebindLaneContext(dir, sid, parentItem, toItem)) return toItem;
	// round-4 (root #123980): the carrier is the splitting item's REGISTERED
	// tree — graph identity, never cwd inequality: a split run FROM the
	// carrier tree (cwd == carrier) still mints. Falls back to the first
	// SHATTERED ancestor's tree when the own tree is gone (chained splits).
	const own = resolveItemWorktree(root, parentItem);
	const carrier = own ?? dirs.filter((d) => d !== cwd)[0];
	if (!carrier) return null;
	// round-5 (root #123982): mint only into an ABSENT file — an existing
	// foreign context is preserved (another owner holds the binding); a
	// corrupt file refuses the mint explicitly and the split rolls back.
	const file = laneContextFile(carrier);
	if (existsSync(file)) {
		if (!readLaneContextFile(carrier))
			throw new Error(
				"kept-child carrier context is corrupt — refusing to overwrite; restore or remove it before splitting",
			);
		return null;
	}
	mkdirSync(join(carrier, ".fleet"), { recursive: true });
	writeFileSync(file, JSON.stringify({ sid, item: toItem }));
	return toItem;
}
