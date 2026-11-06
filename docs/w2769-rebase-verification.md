# W2769 — rebase suspenders/W2741 onto main (merge ladder conflict)

The merge ladder could not land `suspenders/W2741` (merge-tree conflict with
main). This item is the replacement vehicle: merge `refs/heads/suspenders/W2741`
(tip `43d48e13`) into `suspenders/W2769` on main base `0181456e`, resolve
conflicts against current main, run the touched suites, close.

## What landed

- Merge commit `104e34d8` — W2741 content onto current main:
  - `packages/suspenders/hooks/lib/fleet-loop/dangling-rejudge.ts` re-land
    (W2189/W2627 runRejudgeVerb lineage) + `dangling-classify.ts`,
    `dangling-paths.ts`, `merge.ts`, `work-verbs.ts`, `dispatch-next.ts`,
    `hooks/bin/work.ts` deltas
  - test rename `w1762-dangling-rejudge@unit.e2e.ts` →
    `w2189-dangling-rejudge@unit.e2e.ts` (claim-check exact-name credit,
    W2384/W2189 lineage)
  - `docs/w2741-rebase-verification.md` (W2741's own record, carried by the
    merge)
- One conflict: `tests/law-guards.e2e.ts` `NEAR_CAP_PINNED` — the
  `hooks/bin/work.ts` pin. Main held 1268 (main-side lineage re-measures);
  W2741 held 1262. Resolved to the measured count on the MERGED tree:
  `readFileSync(...).split("\n").length` = 1262 (wc -l 1261), keeping a
  merged lineage comment. Law-guards verifies the count on every run.

## Suites run on the merged tree

- `tests/law-guards.e2e.ts` (playwright, `-c tests/playwright.config.ts`):
  14 passed [1.1s] — proves the re-pinned 1262.
- `packages/suspenders/test/w2189-dangling-rejudge@unit.e2e.ts` (playwright,
  `-c test/playwright.config.ts`): 5 passed [1.5s].
- Commit gate (pre-commit hook on the merge commit): 100 pass / 0 fail
  across 11 files.
- `packages/suspenders/test/w1302-merge-dangling.test.ts`: 25 pass / 2 fail
  — A/B against the pre-merge baseline `0181456e` (scratch detached worktree)
  shows the SAME 2 failures (`mergeOne wires the scan`, `post-close repair
  handoff`): pre-existing on main, not introduced by this merge.

## Net delta vs main

The branch tip diff against main is the dangling-rejudge re-land content
plus this doc — nothing else. `git merge-tree --write-tree main HEAD` exits
clean, so the ladder can take this branch in place of the original.
