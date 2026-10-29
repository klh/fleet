// src/stack-config.ts — W230: buckle's zero-dep window into the ONE stack
// config (~/.config/klh/stack.json, mode 600, never committed; KLH_STACK
// overrides the path; W1253 Amendment A: fleet config is JSON — the legacy
// stack.yaml name parses when its content is JSON). Reads the executors rows
// the onboard + lane-wrap surfaces consume; env and CLI flags stay the
// override layer; missing/malformed/oversized config degrades to {} — a bad
// config never blocks onboarding.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STACK_PATH = (): string =>
	process.env.KLH_STACK ?? join(homedir(), ".config", "klh", "stack.json");

/** One executor row: per-executor gateway base(s) + model pin. */
export interface StackExecutor {
	anthropic_base?: string;
	openai_base?: string;
	/** model pin for this executor — routed by id behind belt. */
	model?: string;
}

const MAX_STACK_BYTES = 1024 * 1024;

/** Parse the machine stack config's executors section; any failure
 *  (missing file, malformed JSON, >1 MiB) degrades to {} — never throws. */
export function loadExecutors(): Record<string, StackExecutor> {
	try {
		const path = STACK_PATH();
		if (statSync(path).size > MAX_STACK_BYTES) return {};
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			executors?: Record<string, StackExecutor>;
		} | null;
		const ex = raw?.executors;
		return ex && typeof ex === "object" ? ex : {};
	} catch {
		return {};
	}
}
