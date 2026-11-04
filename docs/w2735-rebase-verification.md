# W2735 — rebase suspenders/W2717 onto main (verification record)

The merge ladder could not land `suspenders/W2717` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2717 content rides `suspenders/W2735` through the ladder instead.

## What landed

- Merge of `parked/W2717` (tip `67629931`) into `suspenders/W2735` on
  base `b3b439e6` (current main lineage).
- Merge base of the two branches: `ce4ecce4` (the W2717 lane's own
  base — W2717 was built on a main descendant, not on main itself).
- Branch delta vs base: 9 commits, 61 files, +488/−363 — the W1294.4
  sweep-B port (58 suspenders/test `*.test.ts` → `*@unit.e2e.ts`
  renames in the knowledge+decant+board+roll+sink+work-tags families),
  the import-ratchet pin-map renames, the test-framework-guard re-pin,
  and the branch's own verification doc.

## Conflicts and resolution

Sole conflict: `tests/test-framework-guard.test.ts` (the W1294
test-framework ratchet pin). Both sides re-pinned after their own port
waves — main pinned 635 (W2649 risk-tier port), the branch pinned 578
(W1294.4 sweep-B, measured on its own lineage). The merged tree carries
BOTH waves, so the correct pin is the count measured on THIS tree:
`git ls-files '*.test.ts'` minus decant minus self = **577** (635 − 58
renames). Resolution: union of both comment lineages + `const PIN =
577`. Shrink-only holds (577 < 635 < both prior bases).

One auto-merged overlap of note: `hub-knowledge-sink.test.ts` was
renamed by the branch AND content-edited on main after the fork (the
W2329 `maxAliasCount: 500` compose-parse guard) — git merged main's
content delta onto the renamed path; verified by inspection.

## Verification runs (merged tree)

- `bun test tests/test-framework-guard.test.ts` — 3 pass / 0 fail
  (ratchet within pin 577).
- `tests/fleet.import-law.guard.e2e.ts` (playwright, root config) —
  7 pass / 0 fail (the pin map's renamed rows resolve).
- `tests/law-guards.e2e.ts` — 14 pass / 0 fail.
- All 58 renamed `*@unit.e2e.ts` specs run under
  `playwright -c packages/suspenders/test/playwright.config.ts`
  (batches): 620+ tests collected. Failures observed, each A/B-proven
  pre-existing on a detached pristine rig of main `b3b439e6`
  (`bun test` on the old `.test.ts`) and/or the parked branch's own
  rig (playwright on the identical spec — byte-same files):
  - board-consult-worker (2), board-kanban-families (5),
    board-prefer (2), board-spend-cells (5), board-splines (1),
    board-volatile-signature (8), board-schemas (1) — identical
    fail sets on baseline; stale pre-W2267 Lit-bridge expectations.
  - fleet-board-demo (4: seeds ×2 + /api/start + /api/ship) — the
    two seeds fails reproduce on main's `.test.ts`; the two
    connection-refused fails reproduce byte-identically on the
    parked branch's own rig (demo board exits before the requests).
  - fleet-board-apiv3 (1: done→ready auto-start) — identical on
    main baseline (work-done exit 2, epoch/env-shaped).
  - federation-board-page (1) — identical `parseUpstreams` JSON
    parse error on baseline (fixture reads the machine stack.json).
  - fleet-board-flows (1: W64 ship e2e) — identical on baseline.
  - fleet-board-lifecycle (1: W182 stub leg) — fails on baseline
    (baseline additionally fails the 5s-timeout start test that
    passes here).
  - fleet-board-store (1), fleet-board-tail (3), fleet-board (2),
    knowledge-api-hardening (1) — identical on baseline.
  - knowledge-integration (4) — byte-identical 4-fail set on the
    parked branch's own rig under the same runner (cross-test
    SYNC_DIR state; 3 of 4 need the server a prior test kills).
  - knowledge-split (2), knowledge (4), w836-board-facts (1) —
    byte-identical on the parked branch's rig.
- `tests/knob-registry.guard.e2e.ts` — 1 fail (`SUSPENDERS_RISK_TIERS`
  undeclared in KNOB_REGISTRY), byte-identical on pristine main —
  pre-existing on both sides, not merge-induced.
- tsc `--noEmit` site-level diff vs pristine main (renamed specs
  mapped back to old names): **zero product-file deltas**; all 138
  new / 135 gone sites live inside the renamed test files (runner
  include-set noise). Both sides carry the same ~10.4k pre-existing
  decant/belt baseline errors.

## Notes

- bun.lock: untouched by the merge (both sides identical at 2.1.3);
  a transient local `bun install` churned version fields and was
  restored to the committed content before staging.
- The W2717 lane's own lesson (`lesson.import-law-rename-adds`)
  prescribes the close path for rename-sweep merges: import-law guard
  green + pin map carries renamed paths (both proven above), then
  `SUSPENDERS_IMPORT_LAW=0` for the single `work done` call, named in
  the summary. This merge follows that precedent.
