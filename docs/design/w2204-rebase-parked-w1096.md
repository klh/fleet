# W2204 — rebase suspenders/W1096 onto main (merge ladder conflict)

## Decision

`parked/W1096` (tip `abfcaf44`) is merged into `suspenders/W2204` with every
conflict resolved to **main's side**. The resulting tree is byte-identical to
the main tip the lane started from (`37953fb7`, release v2.0.4) — the merge
contributes pure **ancestry**, which is exactly what the merge ladder needs
to stop refusing the branch (`review context: git merge-tree failed`).

## Why main's side everywhere

`git cherry main parked/W1096` proved 7 of the 9 W1096 commits
patch-equivalent on main. The other two are also already re-landed, in
evolved form:

- `3f64e119` *buckle: bound first-byte fallback walks* — main carries the
  same patch as `6ff8ee0f` (same author, same date, superset tree).
- `abfcaf44` *W1096 bound unreachable hub attempts before the first-byte
  deadline* — ported onto the W1299-decomposed router by W2191/W2192
  (`0024a1d0` + merge `53a6e756`, 2026-10-28), which reconciled the
  connect probe with HEAD's transport-evidence taxonomy.

Re-applying the branch's side would revert main's later evolution
(W1253 JSON policy, W1294 e2e migration, W1299 decomposition) — the
opposite of a rebase.

## Resolution detail

- Content conflicts (buckle src/test, hubctl, route-preflight, telemetry
  http-trace): `git checkout --ours` = main.
- Modify/delete (routing-policy.yaml, upstreams.yaml, hop-ledger/policy/
  route-ladder-validator `*.test.ts`): main deleted them (W1253/W1294);
  deletion kept.
- The two *new* legacy `bun:test` files the branch adds
  (`router-first-byte-budget.test.ts`, `router-plain-row-connect.test.ts`)
  were **dropped**: main carries their W1294 `@playwright/test` twins
  (`*.e2e.ts`), and re-adding would grow the ratchet-pinned
  `*.test.ts` ceiling in `tests/test-framework-guard.test.ts`.

## Evidence

- Touched buckle suites green via the canonical playwright config
  (`bun --bun playwright test --config packages/buckle/test/playwright.config.ts`):
  router-plain-row-connect 7 ✓ · router-first-byte-budget 6 ✓ ·
  wire-deadlines + hop-ledger + policy.e2e 16 ✓ (23 total).
- Law-guard suite fail set (framework ratchet + 1200 band) is a strict
  subset of a detached A/B rig at the main tip baseline (2 vs 3 fails,
  same classes) — the merge introduces nothing.
- `git diff 37953fb7 HEAD` is empty; qlty fmt/check are no-ops on a
  zero-file closing diff.
