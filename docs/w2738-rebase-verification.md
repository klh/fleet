# W2738 — rebase suspenders/W2666 onto main (verification record)

The merge ladder could not land `suspenders/W2666` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2666 content rides `suspenders/W2738` through the ladder instead.

## What landed

- Merge commit `5ba095d9` — `refs/heads/parked/W2666` (tip `b8fd3177`,
  "W2666: merge parked/W2651 (W1294.12 sweep-I test-corpora port) onto
  main") merged into `suspenders/W2738` on base `b3b439e6` (current
  main lineage).
- Merge base of the two refs: `334d08b6` (already on main). The parked
  branch's unique delta vs that base is 17 commits — the W1294.12
  sweep-I test-corpora port (35 specs across speedy/local/telemetry/
  kernel/local-llm/blam ported `*.test.ts` → tagged `*.e2e.ts`
  @playwright/test, plus the W2300 risk-tier port) with guard re-pins.
- Content vs main: 85 files, +4788/−4548 — the six corpora, guard pins
  (test-framework 636→600, import-ratchet rows), the knob-registry
  guard + helper lib (new from W2666), playwright configs for the six
  packages, and bun.lock devDeps.

## Conflicts and resolution

Two conflicts:

1. `tests/test-framework-guard.test.ts` (content) — both sides
   re-pinned the shrink-only `*.test.ts` ceiling after their own
   waves (main 636→635 via the W2649 risk-tier rebase; branch
   636→600 via the sweep-I port). Resolved by unioning both comment
   histories and pinning to the exact merged-tree count: the merged
   index measures **600** non-decant `*.test.ts` (guard's own
   `git ls-files` counting) — both lineages independently ported
   risk-tier, so the two deltas are disjoint in effect and 600 holds.
2. `packages/suspenders/test/risk-tier.e2e.ts` (add/add) — both
   lineages ported `risk-tier.test.ts` to playwright independently
   (main via W2649 rebase lineage; branch via W2300 with the sweep's
   own convention). `git diff` between the two blobs shows the test
   cases are identical; the only deltas are convention (sweep-I
   header comment, `test.afterEach` cleanup placement inside the
   describe, `@unit` describe tag, one line wrap). Took theirs (the
   sweep-I convention, `fa38338c`) — `git checkout --theirs` (the
   mechanical channel for add/add), then `biome check --write`
   re-sorted the import block.

## Verification runs

On the merged tree (bun 1.4.2, playwright CLI per package config):

- `bun test tests/test-framework-guard.test.ts` — 3 pass / 0 fail
  (ratchet within pin 600 = measured count; teeth + decant-exempt
  proofs).
- `playwright -c packages/suspenders/.../playwright.config.ts
risk-tier.e2e.ts` — 8 passed (the resolved add/add file).
- sweep-I corpora spot checks, one per package:
  kernel 7 passed (`kernel.atomic`, `kernel.env`),
  telemetry 3 passed (`trace-log`, `prefer-header`),
  local-llm 2 passed (`spawner`),
  blam 8 passed (`label`),
  local 2 passed (`dns-maintenance`),
  speedy full suite 55 passed (4 specs, ~1.1m).
- `tests/fleet.import-law.guard.e2e.ts` — passed (part of the 10-pass
  guard run; the one fail there is knob-registry, below).
- biome check on both hand-resolved files — no issues (after
  organize-imports fix).

## Pre-existing failure (A/B-proven on pristine main)

`tests/knob-registry.guard.e2e.ts` — "every prod SUSPENDERS_* knob
resolves to a registry home" fails on `SUSPENDERS_RISK_TIERS`
(read in `packages/suspenders/hooks/lib/fleet-loop/merge.ts:360`).
Both `merge.ts` and `settings.knob-registry.ts` are byte-identical
to main `b3b439e6` (`git diff --stat b3b439e6 -- <files>` empty) —
the fail pre-exists this merge on pristine main. Same disposition as
W2734/W2735/W2736/W2737 (recorded in their work-done summaries);
fixing the registry row belongs to the knob-registry owner, not this
rebase.
