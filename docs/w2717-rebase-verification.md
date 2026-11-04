# W2717 — rebase suspenders/W2665 onto main (verification record)

The merge ladder could not land `suspenders/W2665` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2665 content rides `suspenders/W2717` through the ladder instead.

## What landed

- Merge commit `e3a30074` — `parked/W2665` (tip `8958ff98`) merged
  into `suspenders/W2717` on base `ce4ecce4` (current main lineage).
- The parked branch carries the W1294.4 sweep-B port (60
  suspenders/test knowledge+decant+board+roll+sink+work-tags family
  specs renamed `*.test.ts` → `*@unit.e2e.ts`), the W2650 landing of
  W2481 (the port + the board-policy-disclosure repair), and the
  W2665 tip merge that resolved the ladder's earlier pin conflicts
  (test-framework guard re-pinned to the measured merged-tree count).

## Conflicts and resolution

Sole content conflict: `packages/suspenders/test/board-policy-disclosure.e2e.ts`.

- Our side (main lineage, W2550.1, 2026-11-02) rewrote the card-render
  test onto the `KlhDecisions` Lit module (`policySrcOf` + template
  flattening) and retired `decisions.ts`/the vm stub-DOM harness.
- Their side's deltas to the file predate that: the W1294.4 port's
  biome import re-order and the W2481 repair commit `34fcd953`
  (conflict-marker cleanup + describe-title un-tag).

Resolution: our side for the import block (the parked block imports
the retired `decisions.ts`; the auto-merge also dropped the
`expect, test` import — re-added), our side for the test body
(auto-merged cleanly — their side never touched it), and the describe
title keeps main's ` @unit` suffix (HEAD's corpus convention; the
project name owns routing either way). The resolved file is
byte-identical to HEAD — `git diff HEAD -- <file>` is empty after
resolution; the parked side carries no unique surviving content in
this file.

## Verification runs

All on the merged tree, before the commit:

- `playwright test -c packages/suspenders/test/playwright.config.ts
  test/board-policy-disclosure.e2e.ts` — 5 pass / 0 fail.
- The ported `@unit` corpus, both halves — 190 + 272 = 462 pass /
  0 fail across 33 renamed spec files.
- Guards: test-framework guard 3 pass (bun test — the ratchet holds:
  60 `.test.ts` deletions, 0 adds); law-guards 14, import-law 7,
  knob-registry 4 — all pass on the merged tree.
- `packages/settings` suite — 16 pass / 0 fail (their sweep touched
  `settings.knob-registry.ts` + `settings.env-ratchet.e2e.ts`).
- Commit gate — 100 pass / 0 fail across 11 files, scrub clean,
  504 playwright specs collected.

qlty is not callable from this lane's PATH (known lane limitation);
the resolved file is byte-identical to HEAD's already-formatted bytes,
so no formatting delta exists to verify — the merge ladder's
`qltyFixMergedFiles` pass is the backstop.
