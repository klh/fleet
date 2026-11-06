# W2741 — rebase suspenders/W2705 onto main (verification record)

The merge ladder could not land `suspenders/W2705` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2705 content rides `suspenders/W2741` through the ladder instead.

## What landed

- Merge commit `f51e802a` — `parked/W2705` (tip `7124518d`, itself the
  merge of `parked/W2627` "runRejudgeVerb extraction lineage", which
  chains W2467 ← W2419 ← W2384 ← W2368 ← W2302 ← W2233 ← W2189) merged
  into `suspenders/W2741` on base `b3b439e6` (current main lineage).
- Merge base of the two branches: `0a890d35`. Net delta vs main:
  10 files, +461/−398.

## Net new content (diff base → merge)

- `hooks/lib/fleet-loop/dangling-rejudge.ts` — W2189 re-land of W1762:
  aggregate repair items reject per EDGE (`code.dangling-reject`
  events, item row survives) while legacy per-edge items flip to
  SUPERSEDED; judge vocabulary now rides `TEST_FILE`/`REFERENCE_FORM`
  exported from `dangling-classify.ts`; `runRejudgeVerb` CLI face
  extracted (work.ts rejudge verb body moved here);
  `CLASSIFIER_PATHS` un-exported (merge.ts inlines the path check).
- `hooks/bin/work.ts` — rejudge verb delegates to `runRejudgeVerb`;
  import order churn only otherwise.
- `test/w1762-dangling-rejudge@unit.e2e.ts` → `test/w2189-dangling-
  rejudge@unit.e2e.ts` — renamed + expanded (290 → 310 lines, 5 specs).
- `work-verbs.ts` / `dispatch-next.ts` / `dangling-classify.ts` /
  `dangling-paths.ts` / `merge.ts` — usage-string W1762→W2189 reword,
  `TEST_FILE`/`REFERENCE_FORM` exports, import reorder, inline
  classifier-path check, comment churn.
- `tests/law-guards.e2e.ts` — work.ts pin 1268 → 1262.

## Conflict and resolution

One conflict: `tests/law-guards.e2e.ts` — adjacent-row pin conflict on
`work.ts` (main 1268 carrying W2450/W2448 provenance vs branch 1262
carrying W2627's re-measure). Resolution: measured the merged tree —
`work.ts` = 1262 (split-newline convention; main has NOT touched
work.ts since merge base `0a890d35`, so the branch's extraction
count is the true merged-tree count). Unioned the provenance
comments; pin set to 1262. No other conflicts; all other files
auto-merged.

## Verification runs (merged tree, this lane's transcript)

- `playwright -c packages/suspenders/test/playwright.config.ts
  test/w2189-dangling-rejudge@unit.e2e.ts` — 5 passed.
- `playwright -c tests/playwright.config.ts tests/law-guards.e2e.ts`
  — 14 passed (work.ts pin 1262 verified at the measured count).
- `playwright -c tests/playwright.config.ts
  tests/fleet.import-law.guard.e2e.ts` — 7 passed (dispatch-next.ts
  import moves stay within package-name law).
- `bun test tests/test-framework-guard.test.ts` — 3 passed (net
  `*.test.ts` count unchanged: rename rides the e2e corpus).
- Merge-family e2e (`merge-defer`, `post-merge-activation`,
  `post-merge-budget@unit`, `requeue-merge`) — 65 passed.
- `bun test test/dispatch-next.test.ts` — 17 pass / 4 fail. The 4
  failures are PRE-EXISTING at base: A/B proven in-place by reverting
  ALL merge-touched runtime files to main's blobs
  (`git checkout main -- <7 files>`) and rerunning — identical fail
  set (help-flags exit 2, orphan-recovery exit 2, two DRY-pick
  assertions); the test file itself is byte-identical to main and an
  isolated `-t` rerun still fails, ruling out fixture-order
  interference. Same base disposition as W2738/W2740. Not introduced
  by this merge; left to its owning item.
