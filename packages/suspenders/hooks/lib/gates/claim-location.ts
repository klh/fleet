// hooks/lib/gates/claim-location.ts — W870 location-vs-claim: a session holding a
// claim on an item whose worktree is registered must edit inside that tree.
// Main-checkout edits deny with the tree path named; edits inside any of the
// session's claimed items' trees allow; everything else (no claim, no tree,
// outside the repo) is not this gate's business for parent sessions. Native
// Claude children must hold their own provisioned claim before writing.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveProject } from "../govdb/govdb-project.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import { resolveItemWorktree } from "../work/worktree-lookup.ts";

export interface LocationVerdict {
	blocked: boolean;
	reason?: string;
}

// governor EXEMPT sessions (lease arbitration skipped) skip location too —
// same file, same session-scoped (never subagent-inherited) contract.
const EXEMPT = `${process.env.HOME}/.cache/claude-governor/exempt.json`;

export function locationExempt(sid: string): boolean {
	try {
		if (!existsSync(EXEMPT)) return false;
		const list = JSON.parse(readFileSync(EXEMPT, "utf8")) as string[];
		return Array.isArray(list) && list.includes(sid);
	} catch {
		return false;
	}
}

// canonical path: symlinks resolved for what exists, nearest existing
// ancestor otherwise (Write-new has no file yet) — the governor gate's
// canon, mirrored so both enforcers compare the SAME string
function canon(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		try {
			return `${realpathSync(dirname(p))}/${basename(p)}`;
		} catch {
			return resolve(p);
		}
	}
}

// the one deny path: the session's claimed item(s) hold registered worktree(s)
// in the file's repo; the file sits in the main checkout, under none of them.
export function claimLocationCheck(
	file: string,
	lane: string,
	openDb: () => GovernorStore,
	opts: { requireProvisionedClaim?: boolean } = {},
): LocationVerdict {
	const F = canon(file);
	const rp = resolveProject(dirname(F));
	// Outside Git there is no Work Graph project/tree to bind. In particular,
	// a child may write a scratch file even when the registry is unavailable.
	if (rp.commonDir === rp.cwd) return { blocked: false };
	const rows = openDb()
		.query(
			"SELECT id FROM work_items WHERE project = ? AND owner_sid = ? AND state IN ('CLAIMED','RUNNING')",
		)
		.all(rp.id, lane) as { id: string }[];
	if (!rows.length) {
		return opts.requireProvisionedClaim
			? {
					blocked: true,
					reason: `CLAIM-LOCATION: native child ${lane} has no work claim for ${F}. Take a Work Graph item as this child and edit inside its provisioned worktree. The parent's claim is not inherited.`,
				}
			: { blocked: false };
	}
	const trees: string[] = [];
	for (const r of rows) {
		const w = resolveItemWorktree(rp.root, r.id);
		if (w) trees.push(w);
	}
	// Parent sessions keep the W870 fail-open contract for legacy treeless
	// claims. A native child requires a provisioned tree of its own.
	if (!trees.length) {
		return opts.requireProvisionedClaim
			? {
					blocked: true,
					reason: `CLAIM-LOCATION: native child ${lane} has no provisioned worktree for its claim. Re-take the item as this child before editing ${F}.`,
				}
			: { blocked: false };
	}
	const under = (p: string, base: string): boolean =>
		p === base || p.startsWith(`${base}${base.endsWith("/") ? "" : "/"}`);
	const root = rp.root;
	if (!under(F, root)) return { blocked: false }; // outside the repo
	if (trees.some((t) => under(F, t))) return { blocked: false }; // in-tree edit
	const ids = rows.map((r) => r.id).join(", ");
	const list = trees.join(", ");
	return {
		blocked: true,
		reason: `CLAIM-LOCATION (W870): ${F} is a main-checkout edit while your claim ${ids} holds a provisioned worktree — edit inside the worktree instead: ${list} (dispatch spawns lanes there; work take mints and prints the path). Escapes: work in the tree, or finish (work done) / release the claim.`,
	};
}
