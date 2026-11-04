# W2758 — rebase record: suspenders/W2751 onto main

Branch `suspenders/W2758` (head at close). The ladder could not land
`suspenders/W2751` itself (merge-tree conflict vs main, `bun.lock`); this
branch carries the merge resolved against current main and lands in its
place.

## Situation

W2757 (done @6e5ee5f5) already merged `suspenders/W2751` (b4756503) onto
the main lineage as a46b746e — a genealogical merge: W2602's content was
already on main via W2755, `git diff a46b746e^1 a46b746e --stat` → 0
files; sole conflict `bun.lock` kept HEAD's manifest-consistent 2.1.4
pins. This branch rides that lineage (7b8b01cb merges W2757 in; its only
delta over the lineage is docs/w2757-rebase-verification.md), so W2751 is
an ancestor of this branch's head by construction.

## Evidence (this lane's transcript)

- `git merge suspenders/W2751` → `Already up to date.` (b4756503 already
  an ancestor of HEAD via a46b746e).
- `git merge-base --is-ancestor origin/main HEAD` → true after
  `git fetch origin main` (main = 12e6cc62, unmoved);
  `git merge-tree --write-tree origin/main HEAD` → CLEAN — the ladder's
  merge-tree failure class does not reproduce for this branch.
- `git diff a46b746e^1 a46b746e --stat` → empty (merge tree = first
  parent); `git diff 7b8b01cb^1 7b8b01cb --stat` → the W2757 doc only.
- `bun --bun node_modules/.bin/playwright test -c
  packages/belt/test/playwright.config.ts provider-profiles.e2e.ts
  w277-litellm-supervised.e2e.ts model-access-cost.e2e.ts --reporter=line`
  → 36 passed.
- `bun --bun node_modules/.bin/playwright test -c tests/playwright.config.ts
  law-guards.e2e.ts --reporter=line` → 14 passed.
- `bun --bun node_modules/.bin/playwright test -c
  packages/suspenders/test/playwright.config.ts
  install-openrouter-preflight.e2e.ts --reporter=line` → 5 passed /
  2 failed — pre-existing (below).

## Pre-existing reds (not merge-caused)

`install-openrouter-preflight.e2e.ts` fails at the same two lines (253,
272) dispositioned by W2755 and W2757 (docs/w2757-rebase-verification.md):
the install regen sync list `GENERATOR_FILES`
(packages/suspenders/scripts/install/install-llm-steps.ts) still lacks
`copilot-seat-rows.ts` kit→home sync (fix banked as
`finding.w2755-heal-closure`, not yet landed on main). This branch's tree
is content-identical to its first-parent lineage — every input to the
failing mechanism is unchanged; the reds reproduce identically.
