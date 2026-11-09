# W2917 — re-rebase of parked/W2885 onto origin/main

Date: 2026-11-09. Operator lane: 5d490283 (re-rebase crank lane).

## What

`parked/W2885` (1326 files) re-based onto `origin/main`
`64348ea66c9c32f42916bb1a8f758be0c81fa6a9` as merge `e5d62815` on branch
`tmp/w2917` in a detached /private/tmp worktree.

Branch content: corpus lineage (chord + pi-durable vendored corpus) whose
non-fork surface adds the lane-key face — `hooks/coord/lane-key.ts` +
`test/lane-key-cli.e2e.ts` + `test/lane-auth.e2e.ts`.

## Merges

- `git merge --no-ff parked/W2885` — CLEAN.
- `git merge --no-ff suspenders/W2902` — CLEAN @a29127ba (fork-exemption
  stack: FORKS carve-out in the framework guard, gitleaks entries,
  KNOWN_DEAD import-law pin).
- W902 panel fix applied to
  `packages/suspenders/pi-extensions/fleet-awareness/panel.ts:89`
  (bare `toLocaleTimeString()` → `dualShort` from `hooks/lib/wallclock.ts`)
  — same as every corpus lineage.

## Guards + suites

- bun guards (framework PIN 570-with-FORKS + import-resolution): 9 green.
- playwright guards (law-guards incl. W902, import-law, knob-registry):
  25 green.
- Touched legacy suites: 43 pass / 5 fail — the 5 are the pre-existing
  `board-spend-cells.test.ts` set (A/B-classified on pure main, W2915
  verification).
- Touched e2e: buckle `policy` + `w2260-ping-relay` + `w2579-scoped-idle`
  19 passed; suspenders `board-card-svg-geometry` + `board-density-drawer` +
  `klh-task-card` + `board-activity-scale` + `distill-graph` + `lane-auth` +
  `lane-key-cli` 76 passed.

## Closure

Closing commit = this record doc. Branch pushed as `suspenders/W2917`; item
closed with the record sha via `work done ... --claim-epoch 1`.
