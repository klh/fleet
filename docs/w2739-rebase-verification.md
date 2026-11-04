# W2739 rebase verification record — suspenders/W2668 onto main

Merge `cb542f2e` on `suspenders/W2739` (pushed): parked/W2668 (tip `572ce15f`,
via parked/W2654 = W1294.9.3 sweep-G slice-3, 30 install/hubctl `*.test.ts` →
`@unit.e2e.ts` ports + belt-bin-overlay flat-home unique-ify) onto main lineage
`b3b439e6`. The ladder's `git merge-tree` had failed on one path.

## Conflict (1)

`tests/test-framework-guard.test.ts` — both sides re-pinned the ratchet
ceiling from the 636 base: ours 635 (W2649 risk-tier port, −1), theirs 606
(slice-3's 30 ports, −30). File sets disjoint → union expected 635 − 30 = 605.
Resolved by measuring the merged index (`git ls-files '*.test.ts'`, decant +
self excluded) = **605**, pinning there, keeping both provenance chains.

## Evidence (merged tree, this worktree)

- `bun test tests/test-framework-guard.test.ts` — 3 pass (measured 605 ≤ pin).
- playwright `@unit`, 13 `hubctl@unit` specs — 80 passed (30.2s).
- playwright `@unit`, 17 `install@unit` specs — 126 passed (12.6s).
- `runtime-home-npm-closure.e2e.ts` (references belt-bin-overlay) — 2 passed.
- `bun test test/belt-bin-overlay-flat-home.test.ts` — 4 pass.
- pre-commit gate on the merge commit — 100 tests across 11 files, 0 fail.
- biome check on the 3 non-rename resolved/modified files — clean.

## Notes

- Playwright file filters treat `@` as a regex anchor — quote ported spec
  names with escaped `\@unit` (same trap as W2736's record).
- Ported specs run from `packages/suspenders` with
  `bun --bun node_modules/.bin/playwright test -c test/playwright.config.ts`.
