# W2516 — rebase suspenders/W2247.1 onto main (verification record)

The merge ladder could not land `suspenders/W2247.1` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2247.1 content rides `suspenders/W2516` through the ladder instead.

## What landed

- Merge commit `fd756fe73bd4bf7ac02f1c1693d4ece59593d290` —
  `refs/heads/suspenders/W2247.1` (tip `f33c80d4`) merged into
  `suspenders/W2516` on base `e1280c22` (current main).
- Merge base of the two refs: `eb8b894c`.

## Conflict and resolution

Single conflict, add/add on
`packages/buckle/test/latency-report.e2e.ts`. Resolved main-side
(`git show main:<path> > <path>`, byte-exact):

- main's file is the evolved superset — `@klh/test-kit` adoption
  (`scratchWorld`/`runCli`, W2247.1.1 `d535e4bc`) plus the `@unit` tag
  law (W1294).
- Test inventory is identical both sides (4 specs; same
  `firstBodyByteMs` fixtures and asserts: `{n:3, p50:250, p90:480}`,
  missing-data → `report.firstBodyByte === null`). The branch side is
  the older hand-rolled `mkdtempSync`/`spawnSync` style with no
  additional coverage.

## Parity proof (content already subsumed)

The W2247.1 repair (f33c80d4) had already been ported onto main by W2511
(`3cb24fbd`, the W2247-B1 review repair) — `git diff main
suspenders/W2247.1` is empty on `packages/buckle/src/latency-report.ts`,
`bin/latency-report.ts`, and `docs/design/w2247-*.md`.

- base `e1280c22` tree sha: `a190bbff12e5e6518cd7556071c9fa1cfe40c373`
- merge `fd756fe7` tree sha: `a190bbff12e5e6518cd7556071c9fa1cfe40c373`
- `git diff e1280c22 fd756fe7 --name-only` → empty

Identical trees — the merge introduces zero content drift over main.
This document is the product evidence for the completion window.

## Verification runs

- `bun install --force` (worktree `node_modules` was a bare symlink to
  the main checkout; `@klh/test-kit` did not resolve until installed).
- `bun --bun ../../node_modules/.bin/playwright test -c
  test/playwright.config.ts test/latency-report.e2e.ts` — 4 pass /
  0 fail (buckle package dir).
- `bun -e` import probe on `src/latency-report.ts` — loads clean.
- `rg '<<<<<<<|>>>>>>>'` over the three merged buckle files — no
  leftover conflict markers.
- The post-commit hook's verb-contract sweep failure was scoped to
  `help-no-store.test.ts` / `coord-capsule-project-scope.test.ts`
  (`.test.ts` legacy files, GOVERNOR_STORE_URL env leak under the hook
  runner) — outside this item's four-file scope; the scoped suite above
  is green.
