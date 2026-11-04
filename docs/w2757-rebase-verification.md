# W2757 — rebase record: suspenders/W2751 onto main

Merge commit a46b746e on `suspenders/W2757` (base = main 62fd3af7). The
ladder could not land `suspenders/W2751` itself (merge-tree conflict vs
main, `bun.lock`); this branch carries the merge resolved against current
main and lands in its place.

## Situation

`suspenders/W2751` (tip b4756503) is itself a merge of `suspenders/W2602`
(provider profiles + copilot seat wiring) onto the c2838900 lineage. That
same W2602 content already rides main through W2755's merge e54d7279
(`parked/W2602`): the `packages/` trees are byte-identical at both tips —
`git diff --stat HEAD suspenders/W2751 -- packages/` is empty. This merge
is therefore genealogical: it adds W2751's ancestry so the ladder can land
it; the merge tree is identical to its first parent
(`git diff 62fd3af7 a46b746e --stat` → 0 files).

## Conflicts resolved (1 file)

| File       | Resolution                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun.lock` | kept HEAD (62fd3af7). The W2751 side's lockfile records **2.1.3** workspace pins against its own 2.1.4 manifests (pre-release regeneration; its delta since c2838900 touches zero `package.json` files). HEAD carries W2755's manifest-consistent **2.1.4** regen. `bun install --frozen-lockfile` passes clean (135 installs, no changes) |

## Verification

- `git diff 62fd3af7 a46b746e --stat` → empty (merge tree = first parent;
  W2602 content arrived via W2755).
- `bun --bun node_modules/.bin/playwright test -c
  packages/belt/test/playwright.config.ts provider-profiles.e2e.ts
  w277-litellm-supervised.e2e.ts model-access-cost.e2e.ts --reporter=line`
  → 36 passed.
- `bun --bun node_modules/.bin/playwright test -c tests/playwright.config.ts
  law-guards.e2e.ts --reporter=line` → 14 passed.
- `bun --bun node_modules/.bin/playwright test -c
  packages/suspenders/test/playwright.config.ts
  install-openrouter-preflight.e2e.ts --reporter=line` → 5 passed /
  2 failed — pre-existing on main by tree identity (below).
- `bun install --frozen-lockfile` → no changes (lockfile consistent).
- commit gate: scrub clean, 100 pass / 0 fail (11 files).

## Pre-existing reds (not merge-caused)

`install-openrouter-preflight.e2e.ts` reds (lines 253, 272) fail in the
REAL gateway-config regen leg — the exact class W2755 dispositioned
(docs/w2755-rebase-verification.md): the regen sync list `GENERATOR_FILES`
(packages/suspenders/scripts/install/install-llm-steps.ts) still does not
carry `copilot-seat-rows.ts` kit→home (fix banked as
`finding.w2755-heal-closure`, not yet landed on main). This merge's tree
is byte-identical to its first parent — every input to the failing
mechanism is unchanged; the reds reproduce at the same two lines.
