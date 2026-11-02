# W2496 — rebase suspenders/W2322 onto main (verification record)

The merge ladder could not land `suspenders/W2322` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2322 content rides `suspenders/W2496` through the ladder instead.

## What landed

- Merge commit `90024f60` — `origin/suspenders/W2322` (tip `6024db43`)
  merged into `suspenders/W2496` on base `eac8358e`, pushed to origin.
- Merge base of the two branches: `1e34072a`. W2322's entire delta over
  that base is one line (the `knowledge-distill` heartbeat-born row in
  the drift test); the branch carries no other unique content.

## Conflict and resolution

Single conflict, `packages/suspenders/test/maintenance-legacy-drift.test.ts`
(the HEARTBEAT_BORN map). Resolved as the union superset:

- `gov-gc` → W2274 (HEAD side)
- `knowledge-distill` → 6cec9094 (both sides)
- `hold-drain` → W2318 (HEAD side)

All three names verified present in the merged
`hooks/lib/fleet-loop/maintenance.ts` (the drift contract requires every
HEARTBEAT_BORN row to name a real maintenance task), so the union is the
only resolution that satisfies the W1256.1 partition contract.

## Parity proof (content already subsumed)

- base `eac8358e` tree: `485092587f1886fc0fa774f6a89f972d1ad06624`
- merge `90024f60` tree: `485092587f1886fc0fa774f6a89f972d1ad06624`

Identical trees — the merge introduces zero content drift over main; the
W2322 line was already present at base via an earlier ladder landing.
This document is the product evidence for the completion window.

## Verification runs

- `bun test test/maintenance-legacy-drift.test.ts` — 4 pass / 0 fail
  (after `bun install --force` repaired the stale worktree
  `node_modules` symlink to the main checkout).
- Post-commit verb-contract sweep (the 11-suite `.githooks/post-commit`
  set): 100 pass / 0 fail. The commit-time failure was the known load
  flake plus the stale-symbols state above; re-verified green at current
  fleet load before push.
- Pre-push gate ran on push (branch `suspenders/W2496` on origin).
