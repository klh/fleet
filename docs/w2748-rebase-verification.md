# W2748 — rebase record: parked/W2608 onto main

Merge commit 7603ca7b on `suspenders/W2748` (base = main 1e74147e). The
ladder could not land `suspenders/W2608` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place.

## Situation

`parked/W2608` (tip 75d7f51e, base 597c5ec5) carries the W2505/W2184
contrastive-consult lineage. Main independently landed the same content —
the W2605 merge (main lineage) re-landed the W2494 kb-stats additions and
contrastive counts, so the merge conflicts are same-content drift, not
competing features.

## Conflicts resolved (1 file)

| File | Resolution |
| --- | --- |
| `packages/suspenders/hooks/coord/kb.ts` | comment-only provenance drift (verified via `git diff parked/W2608 -- <path>`: zero code lines differ); kept HEAD's W2605-merge W927 provenance comments — same resolution class as the W2746 kb.ts conflict |

`govdb-open.ts` auto-merged cleanly (the merge-tree preview listed it as
changed-in-both, no conflict hunks).

## Verification

- `git diff 1e74147e 7603ca7b` → empty: the merged tree is byte-identical
  to main tip — all of W2608's functional content already rides main via
  the W2605 lineage merge; this merge supplies ancestry only.
- Touched-module suites on the merged tree (playwright CLI per repo law,
  `bun test` for legacy `*.test.ts` only):
  - `e2e/consult-contrastive.spec.ts` — 7 passed (chromium, e2e config)
  - `test/consult-v2@unit.e2e.ts` — 9 passed
  - `test/knowledge-facts@unit.e2e.ts` — 4 passed
  - `test/w1762-dangling-rejudge@unit.e2e.ts` — 15 passed
  - `test/coord-coordinate.e2e.ts` — 11 passed
  - `test/consult-kb.test.ts` + `test/consult-federation.test.ts` — 37
    passed (bun test)
  - `test/work-completion-record.test.ts` — 15 passed (bun test)
  - `test/gates.test.ts` — 63/67: the 3 push-guard lane-resolution reds
    are environmental spawn-timeout flakes under runner load (5004ms test
    cap; isolated rerun of the exact `gate-spawn.ts` recipe denies
    correctly), and pre-existing by tree identity — the merged tree
    equals main tip, so no merge-caused delta exists.
