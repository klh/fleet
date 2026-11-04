# W2755 — rebase record: parked/W2602 onto main

Merge commit e54d7279 on `suspenders/W2755` (base = main c2838900). The
ladder could not land `suspenders/W2602` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place. W2751 (b4756503) built the same-parents merge an hour
earlier but its branch never landed through the ladder; this merge
re-resolves independently and fixes a lockfile inconsistency in that
precedent (below).

## Situation

`parked/W2602` (tip 9bb7f4ce; the local rename of `suspenders/W2602`,
whose origin ref still exists) holds the provider-profiles + copilot-seat
wiring lineage. Its content mostly already rides main through the landed
twins; `git diff --stat 12e6cc62 parked/W2602` shows 14 files, but almost
all of it is byte-identical on main's side — the merge's net tree delta
vs main is 4 files.

## Conflicts resolved (2 files)

| File | Resolution |
| --- | --- |
| `packages/suspenders/deploy/openrouter-free-refresh.ts` | HEAD side re-added a duplicate W1124.8.4 doc comment above the surviving copy; duplicate dropped, single copy kept (byte-parity with b4756503's resolution) |
| `bun.lock` | regenerated via `bun install --lockfile-only` from the merged package.jsons — @klh/* pinned **2.1.4**, matching the v2.1.4 manifests; `bun install --frozen-lockfile` passes clean. b4756503's lock recorded **2.1.3** pins against its own 2.1.4 manifests (inconsistent); this regen is manifest-consistent |

`packages/belt/bin/model-access.ts` (+1 `node:fs/promises` import) and
`packages/belt/test/w277-litellm-supervised.e2e.ts` (probe models the
wedged-holder three phases) auto-merged.

## Verification

- `git diff c2838900 e54d7279 --stat` → 4 files: bun.lock, model-access.ts,
  w277-litellm-supervised.e2e.ts, openrouter-free-refresh.ts (−3 comment
  lines).
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
- `bun test packages/speedy/test/provider-config.test.ts` → 23 pass / 0 fail.
- commit gate: scrub clean, 100 pass / 0 fail (11 files).
- qlty fmt + check on the three changed .ts files → No issues.

## Pre-existing reds (not merge-caused)

`install-openrouter-preflight.e2e.ts` reds (lines 253, 272) fail in the
REAL gateway-config regen leg: the scratch runtime home's
`gateway-config.ts` imports `./copilot-seat-rows.ts`
(packages/belt/bin/gateway-config.ts:16) but the regen sync list
`GENERATOR_FILES` (packages/suspenders/scripts/install/install-llm-steps.ts:168)
does not carry `copilot-seat-rows.ts` kit→home — the exact W2271
`fallback-health.ts` failure class its own comment documents ("the home
copy dies on module-not-found"). Every input to this mechanism
(install-llm-steps.ts, gateway-config.ts, copilot-seat-rows.ts) is
byte-identical between this merge and base c2838900; this branch's only
delta in the area is 3 deleted comment lines. The fix is a one-line
GENERATOR_FILES addition on main, banked as `finding.w2755-heal-closure`.
