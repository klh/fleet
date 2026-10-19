// Kev's bounded, advisory pass over a completed work item, consult, or capsule.
// A verdict never changes the work or consult trust state by itself.
import type { Database } from "bun:sqlite";
import { kevTypedDecision } from "./kev.ts";

export type CurationKind = "work" | "consult" | "capsule";
export type CurationChoice = "store" | "noise" | "review" | "unavailable";

export interface CurationInput {
	kind: CurationKind;
	title: string;
	text: string;
	reference: string;
	timeoutMs?: number;
}

export interface KevCuration {
	kind: CurationKind;
	reference: string;
	choice: CurationChoice;
	confidence: number | null;
	model: string | null;
	suggestion: string;
}

/** Classify reusable knowledge locally. Low confidence stays in review. */
export async function suggestKnowledge(
	input: CurationInput,
): Promise<KevCuration> {
	const body = input.text.trim();
	const evidence =
		body.length <= 900
			? body
			: `${body.slice(0, 450)}\n...\n${body.slice(-450)}`;
	const decision = await kevTypedDecision({
		state: `${input.kind}: ${input.title.slice(0, 160)}\n${evidence}`,
		question:
			"Does this contain a reusable, evidenced lesson for another Fleet agent? Choose store only for a concrete transferable finding; noise for routine status or repetition; review when evidence is uncertain.",
		options: [
			{
				label: "store",
				tradeoff:
					"Reusable finding with a clear problem, solution, or constraint and evidence",
			},
			{
				label: "noise",
				tradeoff:
					"Routine status, repetition, or private one-off detail with no transferable lesson",
			},
			{
				label: "review",
				tradeoff:
					"Potentially useful but incomplete or uncertain; an agent should check it",
			},
		],
		timeoutMs: input.timeoutMs ?? 8000,
	});
	const confidence = decision?.confidence ?? null;
	const choice: CurationChoice = !decision
		? "unavailable"
		: confidence < 0.55
			? "review"
			: (decision.choice as CurationChoice);
	const suggestion = {
		store: "candidate for coord knowledge-enqueue after checking the evidence",
		noise: "keep the receipt; no knowledge entry suggested",
		review: "check the evidence before deciding whether to store this",
		unavailable: "Kev unavailable; review this for reusable knowledge later",
	}[choice];
	return {
		kind: input.kind,
		reference: input.reference,
		choice,
		confidence,
		model: decision?.model ?? null,
		suggestion,
	};
}

/** Durable, content-minimal receipt for the agent inbox and Board timeline. */
export function recordKnowledgeSuggestion(
	db: Database,
	verdict: KevCuration,
	context: { sid: string; project: string },
): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'kev-curation', 'knowledge.suggested', ?, ?, ?)",
	).run(Date.now(), context.project, JSON.stringify(verdict), context.sid);
}

export function renderKnowledgeSuggestion(verdict: KevCuration): string {
	const confidence =
		verdict.confidence === null
			? ""
			: ` (${Math.round(verdict.confidence * 100)}%)`;
	return `Kev ${verdict.choice}${confidence}: ${verdict.suggestion}`;
}
