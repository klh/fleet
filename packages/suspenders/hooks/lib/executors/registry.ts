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
//   adapterForDetected(name) W1731: a @vercel/detect-agent name → the
//                        adapter whose detect.names claims it; null for
//                        anything unregistered (raw names never surface).
import type { EvidenceNormalizer } from "../gates/claim-evidence.ts";
import type { ExecutorAdapter } from "../lanes/lane.ts";
import { claudeAdapter } from "./claude.ts";
import { clineAdapter } from "./cline.ts";
import { copilotAdapter } from "./copilot.ts";
import { codexAdapter } from "./codex.ts";
import { forgeAdapter } from "./forge.ts";
import { grokAdapter } from "./grok.ts";

export const EXECUTOR_ADAPTERS: ExecutorAdapter[] = [
	claudeAdapter,
	codexAdapter,
	forgeAdapter,
	copilotAdapter,
	grokAdapter,
	clineAdapter,
];

/** The registry default: what an unpinned lane rides (adapterFor's miss). */
export const DEFAULT_ADAPTER: ExecutorAdapter = claudeAdapter;

export const adapterFor = (executor: string): ExecutorAdapter =>
	EXECUTOR_ADAPTERS.find(
		(a) => a.id === executor || a.names.includes(executor),
	) ?? DEFAULT_ADAPTER;

export const adapterForExact = (name: string): ExecutorAdapter | null =>
	EXECUTOR_ADAPTERS.find((a) => a.id === name || a.names.includes(name)) ??
	null;

export const adapterForDetected = (name: string): ExecutorAdapter | null =>
	EXECUTOR_ADAPTERS.find((a) =>
		a.detect?.names.some((n) => name === n || name.startsWith(`${n}_`)),
	) ?? null;

/** Every registered transcript evidence reader. The claim-check reads
 *  prose through all of them, so no client identity can hide a claim. */
export const EVIDENCE_NORMALIZERS: EvidenceNormalizer[] =
	EXECUTOR_ADAPTERS.flatMap((a) => (a.evidence ? [a.evidence] : []));

/** resolveLaneExecutor's gate: only these tokens resolve to a spawnable
 *  binary (catalog rows like grok/cline stay refused until their conversion). */
export const isSpawnableExecutor = (name: string): boolean =>
	adapterForExact(name)?.spawnable === true;

/** W1811: the legacy board-dispatch vocabulary (routes-actions
 *  normalizeAgent's raw-agent pass-through). Grok/cline are RETIRED from it
 *  until their transcript evidence readers land — a dispatchable token
 *  without a reader spawns evidence-blind lanes whose test-pass claims fail
 *  closed by name in the claim-check. Registry-owned so the invariant is
 *  testable beside the adapters it names. */
export const LEGACY_DISPATCHABLE_AGENTS: string[] = ["codex", "copilot"];

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
