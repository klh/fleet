// hooks/lib/completion-curation.ts — W1199 decomposition: the done-path's
// advisory knowledge curation extracted verbatim from work.ts (1500-line
// law). Advisory only — a cold or unavailable Kev cannot reopen or lose
// completed work; telemetry failures never fail the closure.
import type { CompletionRecord } from "./work-completion-record.ts";
import {
	recordKnowledgeSuggestion,
	renderKnowledgeSuggestion,
	suggestKnowledge,
} from "./kev-curation.ts";
import { queueCompletionKnowledge } from "./work-knowledge.ts";

type CurationStore = Parameters<typeof recordKnowledgeSuggestion>[0];

export async function curateCompletionKnowledge(args: {
	db: CurationStore;
	record: CompletionRecord | null;
	item: string;
	title: string;
	text: string;
	sid: string;
	project: string;
}): Promise<void> {
	// Curation is advisory and runs after the durable completion transaction.
	const verdict = await suggestKnowledge({
		kind: "work",
		title: args.title,
		text: args.text,
		reference: args.item,
		timeoutMs: 1500,
	});
	try {
		recordKnowledgeSuggestion(args.db, verdict, {
			sid: args.sid,
			project: args.project,
		});
	} catch {
		// Curation telemetry does not affect an already durable completion.
	}
	console.log(renderKnowledgeSuggestion(verdict));
	if (!args.record) return;
	const knowledge = await queueCompletionKnowledge(
		args.db,
		args.record,
		args.title,
		verdict,
	);
	if (knowledge.status === "queued")
		console.log(`knowledge candidate queued #${knowledge.qid}`);
	else if (knowledge.status === "failed")
		console.error(
			`knowledge enqueue failed for ${args.item}; completion remains done`,
		);
}
