# W2447 — rebase suspenders/W2420 onto main (merge ladder conflict): no-op resolution

2026-11-01 · lane autow2447-p98b319584008df14 · branch `suspenders/W2447`

## Situation

The merge ladder could not land `suspenders/W2420`: `git merge-tree` failed
against main at the time the item was minted. W2447 was opened to merge the
branch (or its `parked/` rename) onto current main, resolve every conflict,
and close — its branch landing through the ladder in place of the original.

## Resolution: nothing left to merge

At handling time `parked/W2420` (`ca805445`) is **already an ancestor of
current main** (`2c7cfbee`): it landed through the ladder upstream via
W2437's merge `8eb4cbd1` ("merge suspenders/W2420 onto main"), which main
contains. Evidence:

- `git merge-base --is-ancestor parked/W2420 main` → exit 0
- `origin/suspenders/W2420` = `ca805445` = `parked/W2420` (identical)
- `git merge-tree --write-tree main parked/W2420` → clean tree
  `5e5aa6c8`, zero conflicts
- `git merge parked/W2420` into this branch → "Already up to date"

So `suspenders/W2447` rides main tip unchanged. Its only content beyond
main is this record (the checkpoint commit is empty; the branch needs at
least one commit to survive worktree reaping, and the done-gate requires a
product path in the closing diff — this file is that path). The ladder can
merge this branch vacuously or drop it; `suspenders/W2420` itself is fully
delivered on main.

The W2420-lineage content that landed via W2437 (reclaim/boot-death work +
the work.ts NEAR_CAP re-pin) is visible in `git show 8eb4cbd1 --stat`:
`hooks/lib/lanes/{boot-death,reclaim-liveness,reclaim-sticky}.ts`,
`hooks/lib/work/{reclaim-verb,work-graph,work-release,work-verbs}.ts`,
`hooks/bin/work.ts`, and tests `boot-death.e2e.ts`, `reclaim-force.e2e.ts`.

## Suites run at main tip `2c7cfbee` (this branch's tree)

All via playwright (`bun --bun node_modules/.bin/playwright test -c …`):

- `tests/law-guards.e2e.ts` — 14 passed
- `packages/suspenders/test/boot-death.e2e.ts` + `reclaim-force.e2e.ts` +
  `reclaim-sticky.e2e.ts` — 21 passed
- `packages/suspenders/test/reclaim-liveness.e2e.ts` +
  `reclaim-liveness-contract.e2e.ts` + `reclaim-sweep.e2e.ts` — 29 passed
- `packages/suspenders/test/lane-attribution.e2e.ts` +
  `bootstrap-lane-metadata@unit.e2e.ts` — 7 passed

## Pre-existing main red (out of scope, filed as W2459)

`packages/suspenders/test/runtime-home-npm-closure.e2e.ts` fails 2 specs at
main tip — NOT a W2420-lineage file (none of the chain below appears in
W2420's unique commits):

```
flat home basename collision: a closure member shares the basename
registry.ts with a cross-package external   (scripts/belt-bin-overlay.ts:162)
```

Import chain: `belt/bin/swarm.ts` → `hubs.ts` →
`@klh/suspenders/hooks/lib/stack-config.ts` →
`hooks/lib/fleet-loop/provider-pools.ts` → `hooks/lib/usage/exec-quota.ts`
→ `hooks/lib/executors/registry.ts` (external) collides with closure
member `belt/bin/registry.ts`. The edge is new in main's lineage with
`d768a4fd` (Merge parked/W2347 into suspenders/W2429 — `provider-pools.ts`
new). The suite is green at its pin commit `266f894a` (W2343), verified by
rerunning it in a detached worktree at that commit: 2 passed. `router-shim.ts`'s
closure has no collision; only `swarm.ts`'s does. Fix direction is recorded
on W2459.
