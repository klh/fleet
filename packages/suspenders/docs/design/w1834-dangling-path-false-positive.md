# W1834 — dangling path `packages/suspenders/e2e/playwright.config.ts`: false positive

## Finding

The path exists and the reference is correct. `packages/suspenders/e2e/`
contains `playwright.config.ts` (tracked since W353, commit b59a8afe — no
history gap around merge 043636c6), and
`packages/suspenders/package.json:12` reads
`"test:e2e": "playwright test --config e2e/playwright.config.ts"`, which
resolves to that file. Zero diff between this branch and `main` for both
paths.

## Why the item looked real

The scanner heuristic-joined the config specifier against the wrong base
directory (same false-positive class as W1806/W1820–W1823/W1825/W1829).
The only real defect found in this lane was environmental: the fresh
worktree's `node_modules/@klh/*` symlinks pointed at the reaped W991.1
worktree, so spec collection failed with
`Cannot find module '@klh/buckle/src/http-kit.ts'`. `bun install --force`
healed it.

## Verification

- `bunx playwright test --config e2e/playwright.config.ts --list` — config
  resolves, 98 tests collected across 34 spec files.
- Focused run `topbar.spec.ts`: 3 passed / 0 failed.

## Disposition

No repair, no rewrite: the reference is correct as written. This document
is the tracked disposition record; branch `suspenders/W1834`, commit head
at close.
