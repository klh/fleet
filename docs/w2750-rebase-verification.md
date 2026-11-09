# W2750 — rebase suspenders/W2738 onto main (verification record)

The merge ladder could not land `suspenders/W2738` (review context: git
merge-tree failed). This item's branch is the replacement vehicle: the
W2738 content (the parked/W2666 sweep-I test-corpora port lineage) rides
`suspenders/W2750` through the ladder instead.

## What landed

- Merge commit `53838461` — `refs/heads/suspenders/W2738` (tip
  `04490cfa`, which includes merge `5ba095d9` of `parked/W2666`)
  merged into `suspenders/W2750` on base `1e74147e` (current main
  lineage at take time).
- The branch's delta vs base is the W1294.12 sweep-I test-corpora port
  (35 specs across speedy/local/telemetry/kernel/local-llm/blam ported
  `*.test.ts` → tagged `*.e2e.ts` @playwright/test) + guard re-pins +
  playwright configs for the six packages, already recorded in
  docs/w2738-rebase-verification.md.

## Conflicts and resolution

Two conflicts:

1. `bun.lock` (content) — main bumped workspace versions to 2.1.4
   (release lineage); the branch added `@playwright/test` devDeps to
   six packages. Resolved by regenerating: `bun install` over the
   merged package.json set (lock picks up main's 2.1.4 pins AND the
   new devDeps; no hand-editing). Verified: zero conflict markers, all
   `@klh/*` references at 2.1.4, `@playwright/test` devDeps present.
2. `packages/speedy/test/provider-config.test.ts` (modify/delete) —
   the branch renamed it to `provider-config.e2e.ts` (sweep-I port)
   while main added a `profileForEnv / profileForEndpoint lookups`
   describe block + imports (W1124.8.x lineage). Resolved by `git rm`
   of the old name and porting main's additions into the renamed file
   in playwright shape (describe nested under the file's `@unit`
   block, `test()` cases, biome organize-imports order). Main's src
   (`packages/speedy/src/provider-config.ts`, where the two functions
   live) merged clean — no src-side conflict.

## Verification runs

On the merged tree (bun 1.4.2, playwright CLI per package config):

- `playwright -c packages/speedy/test/playwright.config.ts
  test/provider-config.e2e.ts` — 23 passed (incl. the two ported
  profileFor tests).
- speedy full suite — 57 passed (~1.6m).
- kernel 27 passed · local-llm 23 passed · local 34 passed ·
  telemetry 33 passed · blam 169 passed (~2.6m) — all six sweep-I
  corpora green.
- `bun test tests/test-framework-guard.test.ts` — 3 pass / 0 fail
  (ratchet pin 600 holds on the merged index).
- `playwright -c tests/playwright.config.ts
  tests/fleet.import-law.guard.e2e.ts` — 7 passed.
- `playwright -c tests/playwright.config.ts tests/law-guards.e2e.ts`
  — 14 passed.
- `bun test packages/suspenders/test/maintenance-legacy-drift.test.ts`
  — 4 pass / 0 fail.
- `playwright -c packages/suspenders/test/playwright.config.ts
  risk-tier.e2e.ts` — 8 passed (part of the 15-test run below).
- biome check on the hand-resolved file — no issues (organize-imports
  applied post-merge).

## Pre-existing failures (A/B-proven on pristine main)

Both reproduced identically on a detached clean-main worktree at
`1e74147e`:

- `packages/suspenders/test/install-openrouter-preflight.e2e.ts` —
  "stale timestamp, groups unchanged: snapshot refreshed, REAL regen
  green" and "route objects with REORDERED properties stay valid
  (#102805 control)" fail with `expect(received).toBe(expected) //
  "failed"` on BOTH trees; the spec file itself rode in from the
  branch, but the fail is environmental (OpenRouter regen), identical
  on clean main.
- `tests/knob-registry.guard.e2e.ts` — "every prod SUSPENDERS_* knob
  resolves to a registry home" fails on `SUSPENDERS_RISK_TIERS`
  (`merge.ts`); `merge.ts` and `settings.knob-registry.ts` are
  byte-identical to main `1e74147e` (empty diff). Same disposition as
  W2734–W2738 (their work-done summaries); the registry row belongs
  to the knob-registry owner (sibling lane W2749 carries it).
