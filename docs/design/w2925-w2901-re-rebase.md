# W2925 — re-rebase of parked/W2901 onto origin/main

Date: 2026-11-09. Operator lane: 5d490283 (re-rebase crank lane).

## What

`parked/W2901` (1330 files) re-based onto `origin/main`
`64348ea66c9c32f42916bb1a8f758be0c81fa6a9` as merge `c648ecbc` on branch
`tmp/w2925` in a detached /private/tmp worktree.

Branch content: corpus lineage (chord + pi-durable + pi-durable-workers); the
pi-durable-workers extension rides the parked W2888-build/OpenRouter-port
work.

## Merges

- `git merge --no-ff parked/W2901` — CLEAN.
- `git merge --no-ff suspenders/W2902` — 9 add/add conflicts, ALL in
  `packages/pi-durable-workers/` (package.json + 8 src files): two
  generations of the package met. HEAD side = the parked branch's morning
  W2901 build (12:16); stack side = the W2943-hygiene generation (18:46)
  which is what actually landed in the fleet. Resolved to the STACK side for
  all 9 files — the newer verified generation supersedes the morning build.
- W902 panel fix applied to
  `packages/suspenders/pi-extensions/fleet-awareness/panel.ts:89`
  (bare `toLocaleTimeString()` → `dualShort` from `hooks/lib/wallclock.ts`).
- Framework-law accommodation: the parked branch carried the DUPLICATE legacy
  suites `pi-durable-workers/test/integration.test.ts` +
  `workers.test.ts` alongside the already-ported `@unit.e2e.ts` versions
  (same-generation ports matching the landed suspenders/W2888 re-rebase
  @e47a3f81). Removed the 2 legacy duplicates (`git rm`) — ratchet 572 → 570,
  and the import-law phantom-dep + reach-in rows (all naming
  integration.test.ts) cleared.

## Guards + suites

- bun guards (framework PIN 570 + import-resolution): 9 green after the
  duplicate removal.
- playwright guards (law-guards incl. W902, import-law, knob-registry):
  25 green.
- pi-durable-workers ported suites (`integration@unit.e2e.ts` +
  `workers@unit.e2e.ts`, package's own playwright config): 22 passed.
- Touched legacy suites: 43 pass / 5 fail — the 5 are the pre-existing
  `board-spend-cells.test.ts` set (A/B-classified on pure main).
- Touched e2e: buckle 19 passed; suspenders 50 passed (board trio +
  activity-scale + distill-graph).

## Closure

Closing commit = this record doc. Branch pushed as `suspenders/W2925`; item
closed with the record sha via `work done ... --claim-epoch 1`.
