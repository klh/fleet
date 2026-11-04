# W2744 — rebase record: parked/W2726 onto main

Merge commit 0e6b09e5 on `suspenders/W2744` (base = main 6ce334c0). The
ladder could not land `suspenders/W2726` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place.

## Situation

`parked/W2726` (tip 9093ea0c) carries the W2626/W2626.1 lineage: the
hub knowledge-sink bun-collectable suite strengthening (W2626.1, 41-line
addition, the Sinai coverage-proof companion to the W2329 dataplane
contract) on top of the already-merged W2621/W2721 chain. Two commits
ahead of main; the substance conflicts only where both lineages touched
the same law-guard comment.

## Conflicts resolved (1 file)

| File | Resolution |
| --- | --- |
| `tests/law-guards.e2e.ts` | two divergent comments for the same dropped hubctl.ts near-cap pin; kept main's wording (it carries the W2448 measured count 1190). Zero code change. |

Auto-merged without intervention: `hub-dataplane.e2e.ts` (import-order
only), `hub-knowledge-sink@unit.e2e.ts` (clean add, main already had the
`@unit.e2e.ts` rename the branch's commit message describes).

## Verification

- `git diff main..suspenders/W2744 --stat` → 2 files:
  `hub-knowledge-sink@unit.e2e.ts` (41 additions, the W2626.1 tests) and
  `hub-dataplane.e2e.ts` (5 lines, biome import-order only — arguments
  and assertions byte-identical).
- playwright: root `law-guards.e2e.ts` 14 passed · suspenders
  `hub-dataplane.e2e.ts` + `hub-knowledge-sink@unit.e2e.ts` 12 passed.
- `bun test tests/test-framework-guard.test.ts` → 3 pass.
- commit pre-commit gate: scrub clean, 100 pass / 0 fail (11 files).
- qlty fmt/check: qlty binary is not callable from lanes (PATH-gated,
  known fleet condition) and this worktree's node_modules carries no
  biome install. Formatting risk is nil: every changed line is verbatim
  from gate-passed parent commits; the one hand-edit (law-guards comment
  resolution) kept main's bytes exactly; the on-write content gate and
  the commit gate both passed.
