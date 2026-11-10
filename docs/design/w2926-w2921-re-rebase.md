# W2926 — re-rebase of parked/W2921 onto current main

Date: 2026-11-10. Operator lane: 5d490283 (re-rebase crank lane).

## What

`parked/W2921` (203 files: the durable-workers/Pi-runtime integration lineage)
re-based onto **current main** `ad5ec8689b559db46750e8030b22ea71b9eac619` as
merge `f3f1ebab` on branch `tmp/w2926` in a detached /private/tmp worktree.

Base choice: origin/main (`64348ea6`) is STALE for this branch — local main
already carries the 15:11 `suspenders/W2927` pi-durable-workers landing, and
merge-tree proved parked/W2921 CONFLICTS against current main while probing
clean against the stale tip. Base = current main; the ladder gets a
descendant of main.

## Merges

- `git merge --no-ff parked/W2921` — 10 add/add conflicts, ALL in
  `packages/pi-durable-workers/` (package.json + 8 src files +
  test/release-support.ts): parked's 14:28 pre-hygiene generation vs main's
  15:11 hygiene generation. Resolved to the MAIN side for all 10 (newer
  verified generation wins; content identity confirmed by the residual diff).
- Residual vs main after resolution: ONLY the two duplicate legacy suites
  `test/integration.test.ts` + `test/workers.test.ts` (+408 lines) that the
  parked branch adds — parked/W2921's actual content ALREADY LANDED on main
  through W2927. Removed the legacy duplicates INSIDE the merge commit (the
  `@unit.e2e.ts` twins on main carry the test names; keeps the closing
  commit doc-only).
- W902 panel fix applied to
  `packages/suspenders/pi-extensions/fleet-awareness/panel.ts` (bare
  `toLocaleTimeString()` → `dualShort` from `hooks/lib/wallclock.ts`) —
  current main still carries the offender, so this branch red→greens W902.

## Guards + suites

- Framework ratchet (PIN 570): PASS.
- Import-resolution: 1 fail — MAIN-INHERITED on `ad5ec868` (dead relative
  imports in `packages/local-llm/lane-load-bench.test.ts → ./registry.ts
(SPECIALISTS)` and `spawner.test.ts → ./spawner.ts (kit)`; untouched by
  this branch: tree vs main = panel.ts only).
- Playwright import-law: 1 fail — MAIN-INHERITED on `ad5ec868`
  (pi-durable-workers declares no `@playwright/test` dev row for its twins;
  untouched by this branch).
- Law-guards (incl. W902 scan green with the fix) + knob-registry: 24 passed.
- pi-durable-workers `@unit.e2e.ts` twins: 22 passed.

## Closure

Closing commit = this record doc. Branch pushed as `suspenders/W2926`; item
closed with the record sha via `work done ... --claim-epoch 1`.
