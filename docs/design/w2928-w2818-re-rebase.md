# W2928 — re-rebase parked/W2818 onto current main

Record of the W2928 re-rebase crank (recipe v2): merge the parked corpus-port
branch onto CURRENT LOCAL main, resolve, prove, close.

## Base choice

- merge-tree probe: `parked/W2818` CONFLICTS against current local main
  `ad5ec868` (the item exists to clear the ladder conflict) — base = `ad5ec868`.
- origin/main (`64348ea6`) is stale for this purpose; stale base re-creates
  the conflict (banked: `lesson.re-rebase-current-main-base`).

## Merge

- `git merge --no-ff parked/W2818` at `8eb23ad1`.
- ONE conflict: `packages/suspenders/package.json` scripts block — resolved
  `--ours` (main's post-W1294 scripts beat parked's old
  playwright-everything scripts: `test` = `bun test test/`, `test:unit` =
  `bun --bun playwright test --config test/playwright.config.ts --project unit`).
- Diff vs main: 387 files, +1798/−1695 — the W2667 corpus-port wave
  (`tests/test-framework-guard.test.ts` PIN 605 → 264, import-resolution
  scan floor 500 → 1000, `tests/helpers/fleet.import-ratchet.pin.ts` −56).

## Riders (generation-newest wins)

1. **W902 panel fix** (`54397e27`): fleet-awareness `panel.ts` renders
   runner-event timestamps via `dualShort` from `hooks/lib/wallclock.ts`.
2. **W2943 hygiene generation** (`3cf87e0f`): `git checkout
suspenders/W2902 -- packages/pi-durable-workers` + `bun install --force`.
   Manifest-only (version 2.2.0, exact pins, `@playwright/test` devDep) —
   fixes check-p1 + the import-law phantom rows
   (`pi-durable-workers: @playwright/test` ×3) inherited from main's W2927
   copy. Banked: `lesson.pi-durable-workers-hygiene-generation`.

## Guard evidence (this tree, post-riders)

- bun battery (`test-framework-guard.test.ts` +
  `test-import-resolution.guard.test.ts`): 7 pass / 1 fail — the 1 is the
  KNOWN main-inherited pair (`packages/local-llm/lane-load-bench.test.ts →
./registry.ts (SPECIALISTS)`, `packages/local-llm/spawner.test.ts →
./spawner.ts (kit)`), byte-identical to base `ad5ec868`.
- playwright battery (law-guards + fleet.import-law + knob-registry):
  25 passed, 0 failed (import-law phantom row cleared by the hygiene rider).
- `check-p1.test.ts`: 5 pass / 0 fail.
- Deleted-test attribution: this branch deletes NO tests; the corpus-port
  deletions rode the merge (pre-closing), the closing commit is doc-only
  (banked: `lesson.done-gate-closing-commit-only`).

## Close

- Closing commit: doc-only (this file). Result ref `refs/heads/suspenders/W2928`.
