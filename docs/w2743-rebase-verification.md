# W2743 — rebase record: parked/W2720 onto main

Merge commit 16df7d1e on `suspenders/W2743` (base = main b3b439e6). The
ladder could not land `suspenders/W2720` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place.

## Situation

`parked/W2720` (tip 789db9af, 12 commits ahead of merge-base ce4ecce4)
holds the W2623 lineage: hub dataplane profile + buckle gov scopes
(W2329/W2463/W2623 chain). Main independently landed the same W2623
content (W2740 record documents the twin for parked/W2724), so the merge
conflicts are same-content drift, not competing features.

## Conflicts resolved (5 files)

| File | Resolution |
| --- | --- |
| `packages/buckle/test/gov-units.e2e.ts` | auto-merged; kept W2720's biome import-order/wrapping pass (semantically identical — only net tree delta vs main) |
| `packages/suspenders/deploy/hub-env-render.ts` | kept main's comment (lists litellm before dataplane) |
| `packages/suspenders/deploy/hub-profiles.ts` | kept main's header + block order; dropped parked/W2720's duplicate litellm block (both sides append it; main's position wins) |
| `packages/suspenders/test/hub-dataplane.e2e.ts` | kept main's test-kit shape (`scratchWorld`/`runCli`, per W2740 precedent) over W2720's hand-rolled mkdtemp/spawn |
| `tests/law-guards.e2e.ts` | kept main's hubctl pin-drop comment (covers both lineages) |

## Verification

- `git diff main..suspenders/W2743 --stat` → 1 file
  (`gov-units.e2e.ts`, 9+/6−): the merged tree is main plus W2720's
  formatting pass only.
- playwright suites: buckle `gov-units.e2e.ts` 15 passed · suspenders
  `hub-dataplane.e2e.ts` + `hub-knowledge-sink@unit.e2e.ts` 10 passed ·
  root `law-guards.e2e.ts` 14 passed.
- `bun test tests/test-framework-guard.test.ts` → 3 pass.
- commit pre-commit gate: scrub clean, 100 pass / 0 fail (11 files).
- qlty fmt + check on `gov-units.e2e.ts` → No issues.
