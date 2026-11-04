# W2730 — rebase suspenders/W2704 onto main (verification record)

The merge ladder could not land `suspenders/W2704` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2704 content rides `suspenders/W2730` through the ladder instead.

## What landed

- Merge commit `c8ae9189` — `parked/W2704` (tip `1445b112`) merged
  into `suspenders/W2730` on base `3f1d003e` (current main lineage),
  pushed to origin.
- Merge base of the two branches: `0a890d35`. The parked branch's
  unique delta vs that base (`git diff --stat 0a890d35 parked/W2704`)
  is 16 files, ALL under `hooks/board-html/vendor/` — regenerated
  bundle artifacts, zero source change. The W2610/W2550 substance
  (board decisions Lit, tasks/core decompose) already lives on main;
  the parked vendor regen predates main's newer one (W2703,
  `1415f7bf` — decisions editorial + card-activity union).

## Conflicts and resolution

All 10 conflicts were vendor artifacts:

- 5 content (`klh-board-mediator.js`, `klh-board-register.js`,
  `klh-console-cards.js`, `klh-decisions.js`, `klh-service-row.js`)
- rename/delete (`lit-12b46f627c606484.js`, `lit-545c35c70481d3d8.js`),
  modify/delete (`lit-b9e6dc75d3d0960d.js`), rename/rename
  (`lit-b9e6dc75d3d0960d.js` → `lit-d1335ced603fe410.js` on main vs
  `lit-dbb2e415bb54e58a.js` on parked)

Hand-splicing minified bundles is the wrong channel: the vendor tree
is generated. Resolved by a fresh canonical rebuild via the ONE build
face (`bun run build:vendor` = `scripts/build-vendor.ts` — rebuild all
entries, content-addressed chunk names, prune stale chunks). Because
the merged sources equal main's sources, the rebuild emits exactly
main's committed vendor: 27 files, byte-identical (staged diff vs HEAD
after the rebuild was empty). Stale chunks `lit-b9e6dc75d3d0960d.js`
and `lit-dbb2e415bb54e58a.js` pruned by the build face itself.

## Parity proof (content already subsumed)

- base `3f1d003e` tree: `c15a7e3a9b7fa64b0daf86e699920e0901daa3ef`
- merge `c8ae9189` tree: `c15a7e3a9b7fa64b0daf86e699920e0901daa3ef`

Identical trees — the merge introduces zero content drift over main;
the parked branch's entire patch was a vendor regen superseded by
main's. This document is the product evidence for the completion
window.

## Verification runs

- `bun test test/vendor-hash.test.ts test/vendor-chunk-names.test.ts`
  (from packages/suspenders) — 7 pass / 0 fail, including
  "committed vendor artifacts byte-match a fresh production build",
  which fails on the conflicted tree and passes on this resolution.
- Commit gate — 100 pass / 0 fail across 11 files (verb-contract
  sweep), playwright coverage 448 specs collected, scrub-gate clean.
