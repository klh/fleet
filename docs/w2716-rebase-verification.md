# W2716 — rebase suspenders/W2484 onto main (verification record)

The merge ladder could not land `suspenders/W2484` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2484 content rides `suspenders/W2716` through the ladder instead.

## What landed

- Merge commit `261d6d48` — `parked/W2484` (tip `2b66a047`) merged into
  `suspenders/W2716` on base `f93a14e8` (the integration base carrying
  `origin/main` `12e6cc62`).
- Merge base of the two branches: `5725263d`. W2484's delta over that
  base is 7 commits (W2274 retention fix → W2289 reconcile → W2325
  merge chain → the W2484 merge + hold-drain HEARTBEAT_BORN row fix),
  touching 8 files.

## Conflict and resolution

Single conflict, `packages/suspenders/test/maintenance-legacy-drift.test.ts`
(the HEARTBEAT_BORN map). W2484's `2b66a047` added `"hold-drain": "W2318"`;
main already carries that row with a richer annotation plus a newer
`lost-hub-sweep` row W2484 predates. Resolved to HEAD's superset:

- `hold-drain` → `W2318 — born on the heartbeat (drain-mode dispatch hold)`
  (HEAD side; carries W2484's row)
- `lost-hub-sweep` → `W2321.4` (HEAD side only)
- `knowledge-distill` / `gov-gc` → both sides, identical

The union superset is the only resolution satisfying the W1256.1 partition
contract (every HEARTBEAT_BORN row must name a real maintenance task —
all names verified present in the merged `maintenance.ts`).

## Parity proof (content already subsumed)

- base `f93a14e8` tree: `36561a36f4acb90d9cdd29876a8368feaa462c3a`
- merge `261d6d48` tree: `36561a36f4acb90d9cdd29876a8368feaa462c3a`

Identical trees — the merge introduces zero content drift over main: the
W2484 payload (retention fix lineage) already landed through earlier
ladder rungs; every file the auto-merge touched resolved to HEAD bytes.
This document is the product evidence for the completion window.

## Verification runs

- `bun test test/maintenance-legacy-drift.test.ts test/retention.test.ts
  test/w603-events-shred.test.ts` — 17 pass / 0 fail.
- `playwright test -c test/playwright.config.ts test/retention-batches@unit.e2e.ts
  test/retention-progress.e2e.ts` — 5 pass / 0 fail.
- Post-commit verb-contract sweep: 99 pass / 1 timeout at commit time
  (`coord-capsule-project-scope.test.ts`, the known spawn-timeout load
  flake); re-run standalone — 2 pass / 0 fail.
- Pre-push gate ran on push (branch `suspenders/W2716` on origin).
