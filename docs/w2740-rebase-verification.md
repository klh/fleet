# W2740 — rebase suspenders/W2724 onto main (verification record)

The merge ladder could not land `suspenders/W2724` (review context:
git merge-tree failed). This item's branch is the replacement vehicle:
the W2724 content rides `suspenders/W2740` through the ladder instead.

## What landed

- Merge commit `a2c96856` — `parked/W2724` (tip `98b9b824`, itself the
  merge of `parked/W2625.1` "hub dataplane profile + scopes") merged
  into `suspenders/W2740` on base `b3b439e6` (current main lineage).
- Merge base of the two branches: `b57e1532`. The parked branch's
  unique delta vs that base is the W2625.1 lineage: the W2329 hub
  dataplane profile (stack-config schema, hub-env-render profile
  block, hub-compose dataplane-api + probe sidecar, buckle
  dataplane scopes) plus its tests.

## Parity proof (content already on main)

Most of the parked delta was ALREADY on main through the W2329
lineage landing independently — both sides carry byte-identical
`stack-config.ts` dataplane schema, `hub-compose.yaml` dataplane
services, `buckle/src/gov/scopes.ts` and the design doc (verified:
`git diff HEAD parked/W2724 --stat` on those paths is empty).

The net new content riding this merge (diff base `b3b439e6` →
merge `a2c96856`):

- `packages/suspenders/test/hub-knowledge-sink@unit.e2e.ts` — the
  two W2625.1 coverage-proof tests pinning the W2329 contract for
  plain `bun test` collection (dataplane profiles line + template
  face/sidecar asserts).
- `packages/buckle/test/gov-units.e2e.ts` — biome formatting of the
  dataplane scope hierarchy asserts (semantics unchanged).
- `tests/law-guards.e2e.ts` — provenance comment union only.

## Conflicts and resolution

Four conflicts, resolved against current main's shape:

- `deploy/hub-env-render.ts` + `deploy/hub-profiles.ts`
  (content + modify/delete): main extracted the compose-profile
  accumulation into `deploy/hub-profiles.ts` (W2329 stop-rule
  decompose) and that file ALREADY carries the dataplane block —
  kept main's extracted shape wholesale; the parked branch's inline
  dataplane insertion into `hub-env-render.ts` is the same logic in
  the pre-extract location.
- `test/hub-dataplane.e2e.ts` (content): kept main's version — it is
  the same spec already migrated to `@klh/test-kit`
  (`scratchWorld`/`runCli`, W1135.1.3 mandate); the parked side is
  the older hand-rolled mkdtemp/spawnSync form.
- `tests/law-guards.e2e.ts` (content): adjacent-row comment conflict
  on the `work.ts` 1268 pin — unioned the provenance (both lineage
  lists are true); kept main's fuller hubctl-drop comment; pin value
  unchanged at 1268, verified measured on the merged tree.

## Verification runs (merged tree, this lane's transcript)

- `playwright -c packages/suspenders/test/playwright.config.ts
  test/hub-dataplane.e2e.ts test/hub-knowledge-sink@unit.e2e.ts` —
  12 passed (incl. the two new coverage-proof tests).
- `playwright -c packages/buckle/test/playwright.config.ts
  test/gov-units.e2e.ts` — 15 passed.
- `playwright -c tests/playwright.config.ts tests/law-guards.e2e.ts`
  — 14 passed (near-cap pins hold at measured counts).
- Verb-contract suites (`bun test` post-commit gate set): 99 pass
  across the 11 files; one `ws-subscribe` consult round-trip hit the
  15s spawn cap under >100-process lane load — known load flake
  (memory: verb-contract load flake), 9/9 pass on rerun at 30s.
- `tests/p1-package-contract-small.e2e.ts`: 31/32 — the one failure
  ("blam: @klh sibling pins agree with the workspace versions",
  `@klh/suspenders` sits in blam `dependencies`, not
  `devDependencies`) is PRE-EXISTING: A/B proven by running the same
  suite at base `b3b439e6` (detached) — identical failure; the test
  and all four manifests involved are byte-identical between base
  and merge (`git diff b3b439e6 a2c96856 -- <those paths>` empty).
  Not introduced by this merge; disposition left to its owning item.
