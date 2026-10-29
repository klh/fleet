// hooks/lib/consult/feedback-obligation.ts — hub design phase 4 (owner
// refinement 2026-10-29): a knowledge-sourced consult answer OBLIGES the
// asking lane to report back (`--feedback resolved|failed --evidence`).
// `work done` names every unreported knowledge answer the lane received
// during the item — C## plus the exact command — as a warning; it blocks only
// when consult.feedback.require_on_done is true (default false).
import { coordSettings } from "./consult-config.ts";
import { feedbackHandle } from "./oracle.ts";

type Store = {
	query(sql: string): {
		all(...p: unknown[]): unknown[];
		get(...p: unknown[]): unknown;
	};
};

export interface Unreported {
	id: number;
	question: string;
}

/** Knowledge answers (FACT/KB, or answered_by = knowledge) this sid asked
 *  since `sinceMs` with no consult_feedback row. */
export function unreportedKnowledgeAnswers(
	db: Store,
	sid: string,
	sinceMs: number,
): Unreported[] {
	try {
		const cols = new Set(
			(db.query("PRAGMA table_info(consults)").all() as { name: string }[]).map(
				(c) => c.name,
			),
		);
		const byKnowledge = cols.has("answered_by")
			? " OR c.answered_by = 'knowledge'"
			: "";
		return db
			.query(
				`SELECT c.id, c.question FROM consults c LEFT JOIN consult_feedback f ON f.consult_id = c.id WHERE c.asker_sid = ? AND c.created_at >= ? AND (c.state IN ('FACT', 'KB')${byKnowledge}) AND f.consult_id IS NULL ORDER BY c.id`,
			)
			.all(sid, sinceMs) as Unreported[];
	} catch {
		return []; // no consult tables on this store: nothing owed
	}
}

/** When the lane took the item: the latest work.claimed event, else the
 *  item's creation. */
export function itemClaimedAt(
	db: Store,
	item: string,
	createdAt: number,
): number {
	try {
		const r = db
			.query(
				"SELECT MAX(ts) AS ts FROM events WHERE kind = 'work.claimed' AND json_extract(payload, '$.work') = ?",
			)
			.get(item) as { ts: number | null } | null;
		return r?.ts ?? createdAt;
	} catch {
		return createdAt;
	}
}

/** The done-path face: prints one warning per unreported answer; calls
 *  `refuse` when the config makes the obligation blocking. */
export function enforceFeedbackObligation(
	db: Store,
	item: string,
	it: { owner_sid?: unknown; created_at?: unknown },
	refuse: (msg: string) => never,
	require = coordSettings().consult.feedback.require_on_done,
): Unreported[] {
	const sid = String(it.owner_sid ?? "");
	if (!sid) return [];
	const since = itemClaimedAt(db, item, Number(it.created_at ?? 0));
	const owed = unreportedKnowledgeAnswers(db, sid, since);
	for (const o of owed)
		console.log(
			`● ${item}: knowledge answer C${o.id} ("${o.question.slice(0, 60)}") has no feedback — ${feedbackHandle(`C${o.id}`)} --as ${sid}`,
		);
	if (owed.length && require)
		refuse(
			`${item}: ${owed.length} knowledge answer(s) unreported — consult.feedback.require_on_done is on; report each, then close`,
		);
	return owed;
}
