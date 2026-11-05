# W2515 — rebase suspenders/W2247 onto main (verification record)

The merge ladder could not land `suspenders/W2247` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2247 content rides `suspenders/W2515` through the ladder instead.

## What landed

- Merge commit `81c5eb4c` — `suspenders/W2247` (tip `63a29fa1`) merged
  into `suspenders/W2515` on base `a03b7d42`, parents `e1280c22` +
  `63a29fa1`.
- Pushed to origin as `suspenders/W2515`.

## Conflicts and resolution

Four add/add conflicts, one per W2247-introduced file:

- `docs/design/w2247-large-request-first-byte-latency.md`
- `packages/buckle/bin/latency-report.ts`
- `packages/buckle/src/latency-report.ts`
- `packages/buckle/test/latency-report.e2e.ts`

HEAD already carried every file in its evolved form: W2247.1 split
headersMs vs firstBodyByteMs (never conflated, never backfilled),
W2247.1.1 moved the test to the test-kit (`scratchWorld`/`runCli`), and
W2511 (`3cb24fbd`) ported the repaired family onto current main. Every
conflict resolved to the HEAD side; the W2247 originals are strict
subsets — headersMs-only metric, hand-rolled mkdtemp/spawnSync fixtures,
no first-body aggregate.

## Parity proof (content already subsumed)

- pre-merge HEAD (`e1280c22`) tree: `a190bbff12e5e6518cd7556071c9fa1cfe40c373`
- merge (`81c5eb4c`) tree: `a190bbff12e5e6518cd7556071c9fa1cfe40c373`

Identical trees — the merge introduces zero content drift over main;
the entire W2247 delta was already present at base via the W2511
landing. This document is the product evidence for the completion
window.

## Verification runs

- `bun --bun node_modules/.bin/playwright test -c
  packages/buckle/test/playwright.config.ts latency-report` — 4 pass /
  0 fail.
- `git merge-tree --write-tree origin/main HEAD` — single tree hash, no
  conflict entries (ladder unblocked).
- `git merge-base --is-ancestor suspenders/W2247 HEAD` — W2247 tip fully
  contained.
- Pre-push gate on push: first attempt 2 fails / 181 (the known fleet
  load flake class), retry 189 pass / 0 fail. The commit-time full-gate
  failure was the stale worktree node_modules cascade
  (`Cannot find module '@klh/test-kit'` etc.) — healed with
  `bun install --force` (+ `--cwd packages/suspenders`); the previously
  red suites re-ran green (verb-surface, help-no-store,
  coord-addressing, coord-fact-cas: 32 pass / 0 fail).
