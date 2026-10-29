// hooks/lib/knowledge/knowledge-votes.ts — hub design phase 4 (owner
// refinement 2026-10-29): the oracle owns the votes. Every knowledge-sourced
// consult answer obliges the asker to report back; the report is a vote on
// the entry that answered:
//   failed   = downvote (with evidence). At `knowledge.downvote_threshold`
//              distinct lanes the entry is demoted out of answering and parked
//              in kev_review (kind 'downvote') with the evidence — a human
//              reviews it; the entry is never silently deleted.
//   resolved = upvote. Promotion EVIDENCE for the human promoter only — it
//              never auto-promotes (D9).
// The table lives in knowledge.db beside the entries so the graph walker
// (fork G) reads the same tallies to rank recall and pick revisit order.
import type { Database } from "bun:sqlite";
import { deferToReview } from "./kev-review.ts";

const DDL =
	"CREATE TABLE IF NOT EXISTS knowledge_votes (entry_id INTEGER NOT NULL, vote TEXT NOT NULL CHECK (vote IN ('up','down')), lane TEXT NOT NULL, consult_id INTEGER NOT NULL, evidence TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, UNIQUE (entry_id, lane, consult_id))";

export function ensureKnowledgeVotes(kb: Database): void {
	kb.run(DDL);
}

export interface VoteTally {
	up: number;
	down: number;
	/** distinct lanes that downvoted — the demotion measure */
	downLanes: number;
}

export function voteTally(kb: Database, entryId: number): VoteTally {
	ensureKnowledgeVotes(kb);
	const r = kb
		.query(
			"SELECT COALESCE(SUM(vote = 'up'), 0) AS up, COALESCE(SUM(vote = 'down'), 0) AS down, COUNT(DISTINCT CASE WHEN vote = 'down' THEN lane END) AS downLanes FROM knowledge_votes WHERE entry_id = ?",
		)
		.get(entryId) as VoteTally | null;
	return r ?? { up: 0, down: 0, downLanes: 0 };
}

export function entryDemoted(
	kb: Database,
	entryId: number,
	threshold: number,
): boolean {
	return voteTally(kb, entryId).downLanes >= threshold;
}

export interface Vote {
	entryId: number;
	vote: "up" | "down";
	lane: string;
	consultId: number;
	evidence: string;
	project?: string;
	topic?: string;
}

export interface VoteOutcome {
	tally: VoteTally;
	/** this vote crossed the threshold: the entry left answering */
	demoted: boolean;
	recorded: boolean;
}

/** Record one vote (one per entry × lane × consult); a downvote that brings
 *  the distinct-lane count to the threshold parks the entry for review with
 *  every downvote's evidence attached. */
export function applyVote(
	kb: Database,
	v: Vote,
	threshold: number,
	now = Date.now(),
): VoteOutcome {
	ensureKnowledgeVotes(kb);
	const before = voteTally(kb, v.entryId).downLanes;
	const recorded =
		kb
			.query(
				"INSERT OR IGNORE INTO knowledge_votes (entry_id, vote, lane, consult_id, evidence, ts) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(v.entryId, v.vote, v.lane, v.consultId, v.evidence, now).changes >
		0;
	const tally = voteTally(kb, v.entryId);
	const demoted =
		v.vote === "down" && before < threshold && tally.downLanes >= threshold;
	if (demoted) {
		const ev = (
			kb
				.query(
					"SELECT lane, consult_id, evidence FROM knowledge_votes WHERE entry_id = ? AND vote = 'down' ORDER BY ts",
				)
				.all(v.entryId) as {
				lane: string;
				consult_id: number;
				evidence: string;
			}[]
		)
			.map((r) => `- C${r.consult_id} ${r.lane.slice(0, 8)}: ${r.evidence}`)
			.join("\n");
		deferToReview(kb, {
			kind: "downvote",
			reference: `k#${v.entryId}`,
			title: v.topic ?? `knowledge entry k#${v.entryId}`,
			text: `demoted out of answering — ${tally.downLanes} lane(s) reported failed (threshold ${threshold}); up ${tally.up}\n${ev}`,
			sid: v.lane,
			project: v.project ?? "",
		});
	}
	return { tally, demoted, recorded };
}
