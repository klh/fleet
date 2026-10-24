# W1255.1 — THEN phase per-file split map

Date: 2026-10-24 · Item: W1255.1 (plan) · Parent map:
`docs/restructure-proposal-2026-10-23.md` THEN child map (suspenders/W1255,
49e2763c) · Baseline fleet `141f7eb4`, anchors re-verified against this tree
2026-10-24.

The parent doc carries the phase-level map; work-graph items carry each
phase. This doc adds the per-file detail behind children W1255.2–W1255.6 —
same scope, finer grain, no new scope. It is plan evidence, not a ledger.

## Children

| item | phase | scope |
| ---- | ----- | ----- |
| W1255.2 | E | scripts/lib lane kit → hooks/lib; retire dispatch-parity |
| W1255.3 | A | knowledge-ports.ts → store-schema/sqlite-store/distill-clients/prompt-policy |
| W1255.4 | B | board/data.ts → per-domain modules (routes-\* grain) |
| W1255.5 | C | work.ts graph-DB core → hooks/lib |
| W1255.6 | D | dispatch-next.ts loop body → hooks/lib/fleet-loop + verb-kit finish |

Measured sizes (this tree): knowledge-ports.ts 1332 · board/data.ts 1482 ·
work.ts 1495 · dispatch-next.ts 1500 · scripts/lib lane kit 798
(lane 328 + lane-auth 432 + launch-parent 25 + lane-retry-budget 13).

## THEN.A — knowledge-ports.ts → 4 modules (W1255.3)

Export map (verified `hooks/lib/knowledge-ports.ts`):

| anchor | lines | target module |
| ------ | ----- | ------------- |
| KnowledgeHit type + KnowledgeJob/KnowledgeUpsert/NearDupProposal/KnowledgeSearchFilters/KnowledgeProposalView/DecaySweep/KnowledgeStore | 41–235 | store-schema.ts |
| DistillClient interface | 247 | distill-clients.ts |
| SqliteKnowledgeStore implements KnowledgeStore | 272–1026 | sqlite-store.ts |
| DistillItem + parseDistill | 1028–1097 | distill-clients.ts |
| systemPrompt/activePrompt/currentPromptHash + FALLBACK_PROMPT | 1099–1131 | prompt-policy.ts |
| LocalLlmDistillClient + BuckleDistillClient | 1133–1245 | distill-clients.ts |
| makeStore/makeDistillClient/enqueueKnowledge/normalizeSourceRef | 1247–1332 | knowledge-ports.ts stays the composition facade re-exporting the four |

Import surface: 15 files import knowledge-ports (11 test files, 4+ hooks
faces: knowledge-worker/knowledge-api/knowledge-mcp/work-knowledge/settle,
gates/files.ts, coord/shared.ts). Parent contract says consumers re-point;
with 15 importers a re-export facade is the churn-minimizing legal
alternative — executor's call, document the choice in the child's done note.

## THEN.B — board/data.ts → per-domain modules (W1255.4)

Verified `hooks/board/data.ts` (1482 lines, 28 exports). Grain follows the
existing `routes-*.ts` siblings; one data-\*.ts per domain:

| domain | anchors (data.ts) | target |
| ------ | ----------------- | ------ |
| work graph | taskShape 59, depEdges 150, workSpendSeries 222, workSpendSeriesPayload 302, workStateCounts 354, tasks 388, workEvents 477, taskDecisions 501 | data-work.ts |
| lanes/sessions | SessionRow/SessionView 772–801, sessions 802, board 852, claims 960, events 982, laneFacts 1012, inbox 1027 | data-lanes.ts |
| activity | activity 525 | data-activity.ts |
| setup/tier | settingsCommands 570, tierFacts 598, llmCheck 634, setupChecks 661 | data-setup.ts |
| decisions | decisionRecords 1118, decisionsPayload 1270 | data-decisions.ts |
| knowledge/llm | llm 1293, factsTrust 1338 | data-knowledge.ts |
| payload assembly | payload 1369, payloadFor 1468 | stays in data.ts (route-face composition) |

data.ts keeps the route-face composition only (payload/payloadFor);
`routes-data.ts` (326 lines) is the single board/data importer — re-point
it domain by domain.

## THEN.C — work.ts graph-DB core → hooks/lib (W1255.5)

Verified `hooks/bin/work.ts` (1495 lines; 1500 cap). The graph-DB core is
lines 113–439 — exactly the parent's anchor:

db() 113, get 203, setState 212, emit 235, deps 255, depsMet 272, reaches
280, rollUp 299, freeDependents 320, nextRootId 344, insertItem 363,
releaseClaim 402, retireItemWorktree 418, releaseObserved 439 →
`hooks/lib/work-graph.ts` (name free in hooks/lib). work.ts keeps the CLI
face + verb doors (showOne 467, dispatchVerb 544, ...) and imports the
core; 1495 → ~1160 lines.

## THEN.D — dispatch-next.ts loop body → hooks/lib/fleet-loop (W1255.6)

Verified `scripts/dispatch-next.ts` (1500 lines, AT the cap). The per-lane
loop body lives ~1248–1500: recovered rows 1248, dispatchable-lane filter
1330, resume map 1361, dispatch loop 1429 → `hooks/lib/fleet-loop/` (dir
already owns events/maintenance/merge/reclaim-sweep/rogue-sweep/
runtime-sync/runtime/stall-watch + dispatch.ts). Loop-body extraction also
unblocks the W651 CLI Toolkit Law verb-kit adoption the parent pinned:
argparse/verb wiring moves with the body, leaving the entry face (argval,
TARGET, DRY, ROUTE consts + admission) under the cap.

## THEN.E — scripts-independence (W1255.2)

Move `scripts/lib/{lane,lane-auth,launch-parent,lane-retry-budget}.ts`
(798 lines) → `hooks/lib/` (names free there). Why: 10 hooks files still
import scripts/lib (session-start, stack-config, work-wait,
supervisor-refill, work-retry, coordinator-edit-gate, report-savings,
plaid-host-pressure, automatic-recovery, fleet-loop/dispatch) — hooks/lib
cannot install without scripts/ today. Moving the lane kit lets the
hooks-side importers re-point inside hooks/lib; remaining scripts/lib
importers stay scripts-side and out of E's scope.

Retire dispatch-parity: `inspectDispatchParity` (scripts/lib/
dispatch-parity.ts, 28 lines) has ZERO production callers — only
test/dispatch-parity.test.ts (78 lines) references it. Delete both files;
no production wiring to unwind. Post-E check: `rg -l "scripts/lib/"
hooks/` must be empty for the moved kit; hooks/lib must install without
scripts/.

## Verification contract (all children)

qlty fmt + check on changed files; bun test on touched areas; 1500-line law
on every produced .ts; export redistribution documented in each child's
done capsule. THEN.E adds: hooks/lib installs without scripts/; parity
machinery gone. THEN.A adds: knowledge tests green post-split
(knowledge/knowledge-curation/knowledge-split/w836-graveyard/w159-settle/
w244-reprocess suites all import the facade).
