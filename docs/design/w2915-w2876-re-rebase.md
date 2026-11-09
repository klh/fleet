# W2915 — re-rebase of parked/W2876 onto origin/main

Date: 2026-11-09. Operator lane: 5d490283 (this re-rebase crank lane).

## What

`parked/W2876` (23 commits, 67 files) re-based onto `origin/main`
`64348ea66c9c32f42916bb1a8f758be0c81fa6a9` as merge
`965bf5b09d70fa81a3dfb0989aef1ee9a1ff56a5` on branch `tmp/w2915` in a
detached /private/tmp worktree (mount-sync-safe tree per the crank recipe).

Branch content: completion provenance proofs — verification of original
completion base in the dependency fixture, dependency gates with registered
claim products, and the completion provenance proof-results doc
(`docs/design/completion-provenance-proofs.md` carries the proof table).

## Merges

- `git merge --no-ff parked/W2876` — CLEAN, no conflicts. No stack merge
  (W2902 fork-exemption stack NOT folded: W2876 is a non-fork branch with no
  chord/pi-durable vendored corpus; the W2902 stack only rides corpus
  lineages). W902 panel fix NOT needed (the offender file
  `pi-extensions/fleet-awareness/panel.ts` is not carried by this lineage —
  law-guards e2e green without it).

## Guards + suites

- Law guards, import-law guard, knob-registry guard e2e: 25 green.
- Framework guard (PIN 605) + import-resolution guard: green in the combined
  run; re-confirmed fresh after the record commit.
- Touched legacy suites standalone: 79 pass / 0 fail across
  `w1106-stream-receipts.test.ts`, `lane-spend.test.ts`, `work-cli.test.ts`.
- `board-spend-cells.test.ts`: 13 pass / 5 fail — classified PRE-EXISTING via
  an A/B rig: a pure-main detached worktree at 64348ea6
  (`/private/tmp/fleet-ab-2915`) shows the IDENTICAL 5-fail set (same five
  test names: kspend line, micro-strip spark, dual-stamp vocabulary, open-age
  label, drawer failure detail). Not branch-introduced; left for the board
  spend owners.
- Touched e2e: buckle `policy.e2e.ts` + `w2260-ping-relay.e2e.ts` +
  `w2579-scoped-idle.e2e.ts` — 19 passed. Suspenders
  `board-card-svg-geometry` + `board-density-drawer` + `klh-task-card` +
  `board-activity-scale` + `distill-graph` + `manual-completion-baseline` —
  62 passed.

## Closure

Closing commit = this record doc (doc-only diff keeps the done-gate
diff-tree product evidence non-empty). Branch pushed as `suspenders/W2915`.
Item closed with the record sha via `work done ... --claim-epoch 1`.
