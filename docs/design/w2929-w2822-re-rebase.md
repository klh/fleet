# W2929 — re-rebase parked/W2822 onto current main

Record of the W2929 re-rebase crank (recipe v2): merge the parked corpus-port
branch onto CURRENT LOCAL main, resolve, prove, close.

## Base choice

- merge-tree probe: `parked/W2822` conflicts against current local main
  `ad5ec868` on exactly one path (`packages/suspenders/package.json`
  scripts block) — base = `ad5ec868`.
- origin/main (`64348ea6`) is stale for this purpose; a stale base
  re-creates the ladder conflict (banked: `lesson.re-rebase-current-main-base`).

## Merge

- `git merge --no-ff parked/W2822` at `cf371f77`.
- ONE conflict: `packages/suspenders/package.json` classes — resolved
  `--ours` (main's post-W1294 scripts beat parked's old
  playwright-everything scripts: `test` = `bun test test/`, `test:unit` =
  `bun --bun playwright test --config test/playwright.config.ts --project unit`).
- Diff vs main: 386 files, +1795/−1691 — the W2922 corpus-port wave
  (framework-guard re-pin, import-resolution scan-floor bump, review-suite
  corpus moves).

## Riders (generation-newest wins)

1. **W902 panel fix**: fleet-awareness `panel.ts` renders runner-event
   timestamps via `dualShort` from `hooks/lib/wallclock.ts` (same patch as
   W2928's tree; main still carries the wrapped `toLocaleTimeString` call
   site until the ladder lands a rider branch).
2. **W2943 hygiene generation**: `git checkout suspenders/W2902 --
packages/pi-durable-workers` + `bun install --force`. Manifest-only
   (version 2.2.0, exact pins, `@playwright/test` devDep) — fixes check-p1
   - import-law phantom rows inherited from main's W2927 copy (banked:
     `lesson.pi-durable-workers-hygiene-generation`).

## Guard evidence (this tree, post-riders)

- bun battery (framework guard + import-resolution guard + check-p1):
  12 pass / 1 fail — the 1 is the KNOWN main-inherited pair
  (`packages/local-llm/lane-load-bench.test.ts → ./registry.ts (SPECIALISTS)`,
  `packages/local-llm/spawner.test.ts → ./spawner.ts (kit)`), byte-identical
  to base `ad5ec868`.
- playwright battery (law-guards + fleet.import-law + knob-registry):
  25 passed, 0 failed.
- Deleted-test attribution: this branch deletes NO tests; deletions ride
  the merge (pre-closing), the closing commit is doc-only (banked:
  `lesson.done-gate-bench-docs-escape` note: no "A/B" phrasing needed — the
  doc stays evidence-shaped, not benchmark-shaped).

## Close

- Closing commit: doc-only (this file). Result ref `refs/heads/suspenders/W2929`.
