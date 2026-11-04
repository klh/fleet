# W2742 — rebase suspenders/W2719 onto main (verification record)

The merge ladder could not land `suspenders/W2719` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2719 content rides `suspenders/W2742` through the ladder instead.

## What landed

- Merge commit `caa550cfd93325839124f07ba64008e0e92b659e` —
  `parked/W2719` (tip `d7eb70dd1e82afea37772278414797dd4ee2427b`) merged
  into `suspenders/W2742` on base `b3b439e6` (current main lineage),
  pushed to origin.
- Merge base of the two branches: `ce4ecce4` (the W2711 merge commit
  both lineages share). The parked branch's unique delta vs that base is
  the W2622 lineage: `buckle:dataplane` scopes + hub deploy profile
  (hub-compose/hub-env-render/hub-profiles, hub-dataplane spec,
  gov-units scope assertions, law-guards pin updates).

## Conflicts and resolution

Three files conflicted:

- `packages/buckle/test/gov-units.e2e.ts` — auto-merged clean (both
  sides added the same dataplane scope assertions independently; the
  auto-merge kept the parked side's biome import-order formatting).
  Net delta vs main: import block reorder only, assertions identical.
- `packages/suspenders/test/hub-dataplane.e2e.ts` — both sides added
  the file independently (add/add). Ours is the kit-migrated shape
  (`@klh/test-kit` scratchWorld/runCli, per the W1135.1.3 tests-ride-
  the-kit law); the parked side's hand-rolled mkdtemp/spawn shape
  predates that migration. Took ours.
- `tests/law-guards.e2e.ts` — both sides re-pinned the same
  `work.ts` 1268 comment and dropped the hubctl.ts pin. Our comments
  are supersets of theirs; took ours.

## Parity proof (content already subsumed)

The W2622 substance was already on main through the independent W2740
landing (same W2623-lineage content): the net tree delta of the merge
commit `caa550cf` vs main `b3b439e6` is ONE file,
`packages/buckle/test/gov-units.e2e.ts`, 9 insertions / 6 deletions — a
biome import-order pass, zero semantic change. (Measured at the merge
commit, before this record doc landed; the branch-tip diff adds only
this doc.) The W2743 lane (parked/W2720, same lineage) verified the
identical shape for its merge.

## Verification runs

- `bun --bun playwright test -c test/playwright.config.ts
  test/gov-units.e2e.ts` (packages/buckle) — 15 pass / 0 fail.
- `bun --bun playwright test -c tests/playwright.config.ts
  tests/law-guards.e2e.ts` (repo root) — 14 pass / 0 fail.
- `bun --bun playwright test -c test/playwright.config.ts
  test/hub-dataplane.e2e.ts` (packages/suspenders) — 5 pass / 0 fail.
- Commit gate (pre-commit, automatic) — 100 pass / 0 fail across 11
  files.
- Pre-push full gate (`.githooks/post-commit --full`) — 189 pass /
  0 fail (the first push attempt hit a 1-fail load flake; clean
  re-run confirmed in transcript).
- `bun x @biomejs/biome check` on the changed file — clean, no fixes.
