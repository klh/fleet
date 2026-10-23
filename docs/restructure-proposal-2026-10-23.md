# Restructure proposal — 2026-10-23

Status: rolling, per-file. Work-graph items carry each phase (this doc is
the map, never a ledger). Baseline measured at fleet `141f7eb4`
(2026-10-23).

## Phases

| Phase | Items        | Scope                                                        |
| ----- | ------------ | ------------------------------------------------------------ |
| P0    | W1246–W1248  | root junk, `.fleet` launch debris, branch disposal           |
| NOW   | W1249–W1252  | import-direction guard, runtime twins, Amendment D drift, `.prefer` verification |
| NEXT  | W1253–W1254  | Amendment A JSON config law, packages/kernel primitives      |
| THEN  | W1255–W1256  | suspenders giants split + scripts-independence, setup single-sourcing |
| 4     | deferred     | package split — re-decide post-measurement, only if `hooks/lib` still >30k lines |

## THEN phase (W1255) — child map

Rolling, per-file. One child per giant, independently landable, ordered by
self-containment:

- **THEN.A — knowledge-ports.ts split** (1332 lines, export map 43–1318):
  → `hooks/lib/store-schema.ts`, `sqlite-store.ts`, `distill-clients.ts`,
  `prompt-policy.ts`; consumers re-pointed; exports redistribute by
  responsibility.
- **THEN.B — board/data.ts split** (1482 lines): → per-domain modules
  matching the `routes-*.ts` grain (routes-actions/lanes pattern).
- **THEN.C — work.ts graph-DB core** (1495 lines, lines 113–439): →
  `hooks/lib` (graph-DB core as a lib module; work.ts keeps the verb
  doors).
- **THEN.D — dispatch-next.ts loop body** (1500 lines): →
  `hooks/lib/fleet-loop/*` + finish verb-kit adoption (CLI Toolkit Law
  W651).
- **THEN.E — scripts-independence**: `scripts/lib/{lane,lane-auth,
  launch-parent,lane-retry-budget}.ts` → `hooks/lib`, so `hooks/lib`
  installs without `scripts/`; then retire the dispatch-parity byte-check
  machinery (`scripts/lib/dispatch-parity.ts`, 28 lines +
  `test/dispatch-parity.test.ts`).

Cross-cutting consolidation (one spawn doctrine collapsing onto
`hooks/lib/run.ts`, one gateway-policy loader, one hub-registry owner, one
config API) is owned by the NOW/NEXT items where it overlaps their scopes
(import-direction guard W1249, Amendment A config law W1253, kernel
primitives W1254) — coordinated there, not duplicated per-child.

## Child verification contract

qlty fmt + check on changed files; `bun test` on touched areas; 1500-line
law on every produced .ts; `hooks/lib` must not import `scripts/` after
THEN.E.
