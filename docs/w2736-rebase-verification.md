# W2736 — rebase suspenders/W2656 onto main (verification record)

The merge ladder could not land `suspenders/W2656` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2656 content rides `suspenders/W2736` through the ladder instead.

## What landed

- Merge commit `4eee7266811428c4207a5bf5f2e9a6423e7abac9` —
  `refs/heads/parked/W2656` (tip `646d71fd`, itself "merge parked/W2475
  sweep-G slice-5 session+usage port") merged into `suspenders/W2736`
  on base `b3b439e6` (current main).
- Merge base of the two refs: `9baae732` (already on main) — the slice
  is the single commit `646d71fd`.
- Content: 17 `packages/suspenders/test/` session-*/usage-* spec ports
  (`*.test.ts` → `*@unit.e2e.ts`/`*@api.e2e.ts` renames + playwright
  scaffolding), the `scripts/port-sweep-g-slice5.ts` port driver, the
  import-ratchet pin row drop for the renamed `usage-provenance` spec,
  and the test-framework guard re-pin.

## Conflict and resolution

Single conflict, `tests/test-framework-guard.test.ts`: both sides
re-pinned the shrink-only `*.test.ts` ceiling after their own waves
(main 636→635 via the W2649 rebase; branch 636→620 via this slice-5
port). Resolved by unioning both comment histories and re-pinning to
the exact merged-tree count:

- main tip: 635 non-decant `*.test.ts` (git ls-files)
- merged tree: 619 (635 − 16 net: 17 renames, one of which
  `session-policy.e2e.ts` → `session-policy@api.e2e.ts` was already
  e2e)
- `const PIN = 619`, guard green (`bun test tests/test-framework-guard.test.ts`
  3 pass / 0 fail at the closing sha).

`tests/helpers/fleet.import-ratchet.pin.ts` auto-merged (main did not
touch it since the merge base; the branch drops exactly the one row for
the renamed `usage-provenance.test.ts`).

## Verification (run on the merged tree)

- `bun test tests/test-framework-guard.test.ts` — 3 pass / 0 fail.
- `playwright -c tests/playwright.config.ts tests/fleet.import-law.guard.e2e.ts`
  — 7 pass / 0 fail (renamed pin rows resolve).
- `playwright -c tests/playwright.config.ts tests/law-guards.e2e.ts`
  — 14 pass / 0 fail.
- Ported specs via
  `playwright -c packages/suspenders/test/playwright.config.ts`:
  56 pass (session-* batch) + 47 pass / 1 fail (usage-* batch) = 103
  pass / 1 fail across the 17 files.

## Known pre-existing failures (not introduced here)

1. `usage-migration@unit.e2e.ts:85` ("cached legacy harvester cannot
   consume verified deltas") — the fixture rewrites the pinned
   historical harvester's (`git show 63ea547^`) relative imports to
   `hooks/lib/<path>`, but W1276 (2026-10-25 compartmentalization,
   landed before both the merge base and the port) moved
   `lib/govdb.ts` → `lib/govdb/govdb.ts`, `lib/board-config.ts` →
   `lib/board/board-config.ts`, `lib/usage-message-ledger.ts` →
   `lib/usage/usage-message-ledger.ts`. A/B proof: pristine main's
   `usage-migration.test.ts` (unchanged since W1276), run untracked in
   this tree, fails identically (`Cannot find module …/hooks/lib/govdb.ts
   from …/cached-legacy.ts`) — 6 pass / 1 fail, same test. The port's
   test logic is byte-identical to main's copy (diff = framework
   scaffolding + import reorder only).
2. `tests/knob-registry.guard.e2e.ts` — `SUSPENDERS_RISK_TIERS` has no
   `KNOB_REGISTRY` row (read in
   `packages/suspenders/hooks/lib/fleet-loop/merge.ts`). That file is
   untouched by this merge (byte-identical to main) and the registry
   row is absent on main too — same single-offender payload on
   pristine main. Sibling lanes W2734/W2735/W2737 closed with the same
   disposition.

qlty fmt/check could not run from this lane (qlty binary not on the
lane PATH — interactive approval required); the on-write content gate
parse-checked every edit, the one hand-edited file's guard suite is
green, and the merge ladder's `qltyFixMergedFiles` backstop runs at
integration.
