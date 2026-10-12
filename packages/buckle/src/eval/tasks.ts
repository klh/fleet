// src/eval/tasks.ts — the task registry: per-shape generators behind one
// entry point. The seed pins the list, so both arms run THE SAME tasks.
import { makeDanishTasks } from "./danish.ts";
import { makeCodeTasks } from "./tasks-code.ts";
import { makeMenialTasks } from "./tasks-menial.ts";
import { makeReasoningTasks } from "./tasks-reasoning.ts";
import type { Shape, Task } from "./types.ts";

const GENERATORS: Record<Shape, (n: number, seed: number) => Task[]> = {
	code: makeCodeTasks,
	menial: makeMenialTasks,
	reasoning: makeReasoningTasks,
	danish: makeDanishTasks,
};

export function makeTasks(shape: Shape, n: number, seed: number): Task[] {
	return GENERATORS[shape](n, seed);
}
