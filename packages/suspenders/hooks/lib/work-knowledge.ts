// A completed work receipt is durable before this best-effort knowledge handoff.
// The ingest worker decides which parts become candidate knowledge.
import type { Database } from "bun:sqlite";
import type { KevCuration } from "./kev-curation.ts";
import { enqueueKnowledge } from "./knowledge-ports.ts";
import type { CompletionRecord } from "./work-completion-record.ts";

export async function queueCompletionKnowledge(
	db: Database,
	record: CompletionRecord,
	title: string,
	verdict: KevCuration,
	enqueue: typeof enqueueKnowledge = enqueueKnowledge,
): Promise<
	{ status: "queued"; qid: number } | { status: "skipped" | "failed" }
> {
	if (verdict.choice === "noise" || !record.summary.trim())
		return { status: "skipped" };
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
