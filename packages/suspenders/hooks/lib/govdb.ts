// hooks/lib/govdb.ts — shared governor registry DB (SQLite, WAL).
// One connection shape for every writer; busy_timeout is set BEFORE
// journal_mode: under contention the connection waits instead of throwing;
// WAL is persistent once set and verified on open.
//
// W624 decomposition — the file split by responsibility into sibling
// modules; THIS entrypoint re-exports the same public surface, so the
// 100+ consumers importing here never change:
//   govdb-util.ts      REG path, columnNames probe, the WAL-open shape
//   govdb-project.ts   project identity (git-common-dir realpath resolver)
//   govdb-knowledge.ts knowledge schema: v10 file split, v6/W91 layer,
//                      openKnowledgeDb
//   govdb-deltas.ts    delta-log trigger generation + pruneDeltas
//   govdb-open.ts      openGovernorDb (the schema/migration ladder) + the
//                      JSON→SQL registry migration
//   govdb-store.ts     the W92 store port (interfaces, HTTP binding,
//                      binding resolver)
//   govdb-sessions.ts  liveness sweep + the session-name bridge
import { pinReg } from "./govdb-util.ts";

// REG lives once in govdb-util; every entry instance (the ?home= test
// convention mints one per suite) re-pins it to its load-time HOME —
// per-suite isolation rides THIS call.
pinReg();

// capability vocabulary for capability-aware dispatch (schema v2):
// work_items.requires ⊆ sessions.capabilities or work take refuses
export const CAPABILITIES = [
	"shell",
	"fs",
	"git",
	"build",
	"mcp",
	"vision",
	"browser",
	"network",
];

// W54 — THE decision-kind gate, shared by every consumer of NEED% forks
// (advise.ts, the board's /api/advise + /api/ack). coord emit passes kinds
// through verbatim, and a lane shipped 'need-decision'; syncDecisions'
// backfill uses SQL LIKE 'NEED%', which SQLite matches case-INsensitively —
// so the board listed forks the case-sensitive startsWith("NEED") gates then
// refused to advise on (live 500). Uppercase-only normalization keeps this
// EXACTLY equal to that LIKE accept set (stripping [-_] would widen it).
export function isDecisionKind(kind: string): boolean {
	return kind.toUpperCase().startsWith("NEED");
}

// W15/W24 metrics (workTiming/tokenUsage) live in work-timing.ts since W603
// (1500-line law; the shredded project column) — re-exported, so consumer
// import surfaces (fleet.ts, shared.ts, fleet-board.ts, metrics.test.ts)
// never change.
export { workTiming, tokenUsage } from "./work-timing.ts";
export type { ItemTiming, ItemTokens } from "./work-timing.ts";
export {
	projectIdentity,
	projectRootOf,
	resolveProject,
} from "./govdb-project.ts";
export type { ResolvedProject } from "./govdb-project.ts";
export { migrateKnowledgeSplit, openKnowledgeDb } from "./govdb-knowledge.ts";
export { openGovernorDb } from "./govdb-open.ts";
export { pruneDeltas } from "./govdb-deltas.ts";
export {
	HttpGovernorStore,
	knowledgeSqlViolation,
	openMemoryStore,
	openStore,
	resolveStoreHttpBase,
} from "./govdb-store.ts";
export type {
	GovernorStatement,
	GovernorStore,
	StoreResult,
} from "./govdb-store.ts";
export { sweepStaleSessions, tagNameOf } from "./govdb-sessions.ts";
