// A completed work receipt is durable before this best-effort knowledge handoff.
// The ingest worker decides which parts become candidate knowledge.
import type { Database } from "bun:sqlite";
import type { KevCuration } from "../knowledge/kev-curation.ts";
import { invalidateForLanding } from "../knowledge/knowledge-invalidate.ts";
import { curationGate, deferToReview } from "../knowledge/kev-review.ts";
import {
	enqueueKnowledge,
	withKnowledgeDb,
} from "../knowledge/sqlite-store.ts";
import type { CompletionRecord } from "./work-completion-record.ts";

export async function queueCompletionKnowledge(
	db: Database,
	record: CompletionRecord,
	title: string,
	verdict: KevCuration,
	enqueue: typeof enqueueKnowledge = enqueueKnowledge,
): Promise<
	| { status: "queued"; qid: number }
	| { status: "skipped" | "failed" | "deferred" }
> {
	const gate = curationGate(verdict.choice);
	if (gate === "drop" || !record.summary.trim()) return { status: "skipped" };
	// D7: no verdict is not a store verdict — park it for the Kev drain
	if (gate === "defer") {
		try {
			withKnowledgeDb((kb) =>
				deferToReview(kb, {
					kind: "work",
					reference: record.item,
					title,
					text: record.summary,
					sid: record.completed_by,
					project: record.project,
				}),
			);
			return { status: "deferred" };
		} catch {
			return { status: "failed" };
		}
	}
	try {
		const qid = await enqueue({
			source: `work.done ${record.item}`,
			payload: JSON.stringify({
				item: record.item,
				title,
				summary: record.summary,
				commit: record.commit_sha,
				kev: verdict.choice,
			}),
			domain: "private",
			originSid: record.completed_by,
		});
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'work-knowledge', 'knowledge.enqueued', ?, ?, ?)",
		).run(
			Date.now(),
			record.project,
			JSON.stringify({ work: record.item, project: record.project, qid }),
			record.completed_by,
		);
		return { status: "queued", qid };
	} catch (error) {
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'work-knowledge', 'knowledge.enqueue_failed', ?, ?, ?)",
		).run(
			Date.now(),
			record.project,
			JSON.stringify({
				work: record.item,
				project: record.project,
				error: error instanceof Error ? error.name : "unknown",
			}),
			record.completed_by,
		);
		return { status: "failed" };
	}
}

// W1228: the done-verb's knowledge handoff — invalidate first, then queue.
// The closing diff flags matching knowledge/facts stale-for-review and
// promotes the item's finding.* facts; fail-open, a landing never breaks
// over knowledge work.
export function landCompletionKnowledge(
	db: Database,
	record: CompletionRecord,
	title: string,
	verdict: KevCuration,
	opts: { repo: string },
): ReturnType<typeof queueCompletionKnowledge> {
	try {
		const inv = withKnowledgeDb((kb) =>
			invalidateForLanding({
				repo: opts.repo,
				item: record.item,
				sha: record.commit_sha,
				base: record.baseline_sha,
				via: "work.done",
				gov: db,
				kb,
			}),
		);
		if (inv)
			console.log(
				`knowledge stale: ${inv.knowledge} row(s), ${inv.facts} fact(s) flagged; promoted: ${inv.promoted.join(", ") || "none"}`,
			);
	} catch {}
	return queueCompletionKnowledge(db, record, title, verdict);
}
