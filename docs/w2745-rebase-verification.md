# W2745 — rebase record: parked/W2727 onto main

Merge commit 7e71eef9 on `suspenders/W2745` (base = main 6ce334c0). The
ladder could not land `suspenders/W2727` itself (merge-tree conflict vs
main — the ref lives as `parked/W2727`, tip 8d81ccb6); this branch carries
the merge resolved against current main and lands in its place.

## Situation

`parked/W2727` (merge-base 3f1d003e) holds the W2628 lineage: the W2468
test-kit migration (`scratchWorld`/`runCli`) of the hub-dataplane suite
plus a biome pass on `gov-units.e2e.ts`. Main independently landed the
same content through twin landings (W2740 record documents the
hub-dataplane twin; W2742 the gov-units one), so the merge conflict is
same-content drift, not competing features.

## Conflict resolved (1 file)

| File | Resolution |
| --- | --- |
| `packages/suspenders/test/hub-dataplane.e2e.ts` | kept main's blob (biome-organized imports + the W2725 `const hostsContract` extraction) — parked/W2727's side is semantically identical W2468 content in pre-biome-pass shape; W2743 line 23 sets the precedent |

`packages/buckle/test/gov-units.e2e.ts` auto-merged and is byte-identical
to main on both sides.

## Verification

- `git diff main..HEAD` (merge commit) → **zero bytes**: the entire
  parked/W2727 tree delta already reached main via the twin landings; this
  merge contributes the lineage connection only.
- playwright suites on the merged tree: suspenders `hub-dataplane.e2e.ts`
  5 passed · buckle `gov-units.e2e.ts` 15 passed · root `law-guards.e2e.ts`
  14 passed.
- `bun test tests/test-framework-guard.test.ts` → 3 pass.
- merge-commit pre-commit gate: scrub clean, 100 pass / 0 fail (11 files).

Note: `test/hub-dataplane.spec.ts` (bun-collectable, W2624.1) belongs to
the sibling `parked/W2722` lineage (item W2749), not to parked/W2727 — it
is correctly absent here.
