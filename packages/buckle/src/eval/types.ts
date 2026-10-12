// src/eval/types.ts — shared shapes for the W424 model-swap eval harness.
// A task's answer key is COMPUTED at generation time from the generator's own
// inputs — never typed by hand — and `check` grades normalized answers
// against it. Two arms run the identical seed-pinned task list (paired).

export type Shape = "code" | "menial" | "reasoning" | "danish";

export const SHAPES: readonly Shape[] = [
	"code",
	"menial",
	"reasoning",
	"danish",
] as const;

export interface Task {
	id: string;
	shape: Shape;
	system: string;
	prompt: string;
	/** Computed answer key (canonical string form). */
	key: string;
	/** Grader: true iff the answer is correct (normalized compare vs key). */
	check: (answer: string) => boolean;
	/** Family + extras; code tasks carry meta.code (the raw snippet, vm-verified in tests). */
	meta: Record<string, string | number>;
}

export interface Arm {
	name: "a" | "b";
	url: string; // openai-compat base, e.g. http://127.0.0.1:8902/v1
	model: string;
	key?: string; // bearer token, optional
	price_in?: number; // USD per 1M input tokens
	price_out?: number; // USD per 1M output tokens
}

export interface TaskResult {
	task_id: string;
	shape: Shape;
	arm: "a" | "b";
	repeat: number;
	ok: boolean;
	error?: string;
	latency_ms: number;
	tokens_in: number;
	tokens_out: number;
	answer: string;
}
