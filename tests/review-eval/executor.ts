// tests/review-eval/executor.ts — the headless review-agent executor leg.
// Both arms ride the identical W960 recipe: `claude -p --output-format json`
// with the arm's skill text appended to the system prompt plus a bench
// contract that forbids tools/network/commits. The arm skill is the ONLY
// variable between arms; ask, file, model pin and settings pin are matched.
import type { ReviewTask } from "./corpus.ts";

export const BENCH_CONTRACT =
	"Bench contract: this is a single-shot read-only review of the file " +
	"provided in the task prompt. Do not run shell commands or tools, do " +
	"not commit, do not call coordination CLIs, do not fetch the network. " +
	"Reply with the review text only.";

export function buildTaskPrompt(task: ReviewTask): string {
	return [
		task.ask,
		"",
		`File under review — ${task.name}`,
		"",
		task.content,
	].join("\n");
}

export function buildSystemPrompt(skillContent: string): string {
	return `${skillContent.trim()}\n\n${BENCH_CONTRACT}`;
}
