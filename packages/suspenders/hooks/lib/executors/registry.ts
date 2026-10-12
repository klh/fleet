// hooks/lib/executors/registry.ts — the executor-adapter registry (W422
// surface consolidation law). Core dispatch code (dispatch-next, exec-chain,
// launch-preflight, lane-starter, lane-liveness) carries ZERO executor
// branches: every agent's specifics live in its adapter file, and a new
// agent is one adapter file + one row in EXECUTOR_ADAPTERS below.
//
// Lookup semantics:
//   adapterFor(name)     .prefer/default_executors token -> adapter; a MISS
//                        is a belt MODEL pin and rides the claude CLI (W183.2:
//                        belt routes by model id, so a model name IS an
//                        executor riding the claude binary).
//   adapterForExact(name) no fallback — null when the token names no agent.
//                        Starter-fork resolution rides this: an unknown
//                        harness must cold-start, never fork like claude.
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";
import { claudeAdapter } from "./claude.ts";
import { clineAdapter } from "./cline.ts";
import { copilotAdapter } from "./copilot.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";

export const EXECUTOR_ADAPTERS: ExecutorAdapter[] = [
	claudeAdapter,
	codexAdapter,
	copilotAdapter,
	grokAdapter,
	clineAdapter,
];

export const adapterFor = (executor: string): ExecutorAdapter =>
	EXECUTOR_ADAPTERS.find(
		(a) => a.id === executor || a.names.includes(executor),
	) ?? claudeAdapter;

export const adapterForExact = (name: string): ExecutorAdapter | null =>
	EXECUTOR_ADAPTERS.find((a) => a.id === name || a.names.includes(name)) ??
	null;

/** resolveLaneExecutor's gate: only these tokens resolve to a spawnable
 *  binary (catalog rows like grok/cline stay refused until their conversion). */
export const isSpawnableExecutor = (name: string): boolean =>
	adapterForExact(name)?.spawnable === true;

/** The process-table names every executor answers to — lane-liveness's
 *  harness matcher feeds from this union instead of a hand-kept list. */
export const HARNESS_PROCESS_NAMES: string[] = [
	...new Set(EXECUTOR_ADAPTERS.flatMap((a) => a.processNames)),
];

/** PATH-independent install locations (adapters declare their native
 *  installs; lane-liveness probes these when `which` misses). */
export const HARNESS_INSTALL_PATHS: string[] = [
	...new Set(EXECUTOR_ADAPTERS.flatMap((a) => a.installPaths ?? [])),
];
