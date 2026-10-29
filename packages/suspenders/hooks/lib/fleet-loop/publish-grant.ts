// hooks/lib/fleet-loop/publish-grant.ts — W2270: the one-use publication
// grant that binds a refs/heads/main update to review evidence. The
// reference-transaction hook trusts nothing caller-supplied (no env pair,
// no writable bearer file): a reviewed publication must carry a grant row
// minted in the coordination store by the merge guard after the final
// exact-commit PASS review, and the hook independently re-derives the
// receipt binding from immutable git objects before honoring it. The store
// is the evidence root — the same root the review receipts live in.
import type { GovernorStore } from "../govdb/govdb-store.ts";

// a minted grant must be consumed within this window; the merge guard mints
// immediately before its single publish attempt, so the TTL only bounds
// grants stranded by a failed or never-attempted publication.
export const PUBLISH_GRANT_TTL_MS = 10 * 60_000;

export interface PublishGrant {
	project: string;
	item: string;
	branch: string;
	old: string;
	new: string;
}

// baseline DDL — openGovernorDb also runs it at every open, and the lib
// self-heals against stores opened before this landing (a long-lived store
// server process never re-runs openGovernorDb).
export function ensurePublishGrantsTable(db: GovernorStore): void {
	db.run(
		"CREATE TABLE IF NOT EXISTS publish_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, item TEXT NOT NULL, branch TEXT NOT NULL, old_sha TEXT NOT NULL, new_sha TEXT NOT NULL, minted_at INTEGER NOT NULL, consumed_at INTEGER)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS publish_grants_lookup ON publish_grants(project, branch, old_sha, new_sha, consumed_at)",
	);
}

export function mintPublishGrant(
	db: GovernorStore,
	grant: PublishGrant,
	now = Date.now(),
): void {
	ensurePublishGrantsTable(db);
	db.run(
		"INSERT INTO publish_grants(project, item, branch, old_sha, new_sha, minted_at) VALUES (?, ?, ?, ?, ?, ?)",
		grant.project,
		grant.item,
		grant.branch,
		grant.old,
		grant.new,
		now,
	);
}

/** One-use by construction: the matching unconsumed row is consumed in a
 * single guarded UPDATE, so a race can never honor one grant twice. The
 * hook matches project + the exact old→new pair; item and branch ride back
 * for its independent review re-verification. */
export function consumePublishGrant(
	db: GovernorStore,
	grant: Pick<PublishGrant, "project" | "old" | "new">,
	now = Date.now(),
	ttlMs = PUBLISH_GRANT_TTL_MS,
): {
	ok: boolean;
	why: string;
	item?: string;
	branch?: string;
} {
	ensurePublishGrantsTable(db);
	const row = db
		.query(
			"SELECT id, item, branch, minted_at FROM publish_grants WHERE project = ? AND old_sha = ? AND new_sha = ? AND consumed_at IS NULL AND minted_at > ? ORDER BY id DESC LIMIT 1",
		)
		.get(grant.project, grant.old, grant.new, now - ttlMs) as {
		id: number;
		item: string;
		branch: string;
		minted_at: number;
	} | null;
	if (!row)
		return {
			ok: false,
			why: "no unconsumed publication grant for this exact ref pair",
		};
	const verdict = db.run(
		"UPDATE publish_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
		now,
		row.id,
	);
	if (!verdict.changes)
		return { ok: false, why: "publication grant already consumed" };
	return { ok: true, why: "", item: row.item, branch: row.branch };
}
