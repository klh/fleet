# W2276 — sweep-G family split: partition verification (W1294.9)

Date 2026-10-29 · Item W2276 · Parent W1294.9 · Census tree `e1ae5072`

## Verdict

The sweep-G partition already existed as children W1294.9.1–.6 (parent SHATTERED
2026-10-29). This item verified the partition against the tree and closed one
coverage gap by minting W1294.9.7.

## Partition table

Census basis: every tracked `*.test.ts` under `packages/suspenders/test/` whose
name loose-prefix-matches the W1294.9 family regex
`^(fleet|hubctl|install|hub|session|claude|usage|launch|store|federation|service|services|policy|copilot|litellm|servicemon|remotes)`
— loose boundary, no suffix requirement, exactly as the parent mission states
it. Count at `e1ae5072`: **124**.

| Child | Scope | Files | State 2026-10-29 |
| --- | --- | --- | --- |
| W1294.9.1 | `policy-*` `copilot-*` `litellm-*` `servicemon*` `services-*` `remotes*` | 10 | claimed, no branch yet |
| W1294.9.2 | `fleet*` (incl. `fleet.test.ts`) | 23 | done — `parked/W1294.9.2` |
| W1294.9.3 | `install-*` + `hubctl-*` | 30 | done — `suspenders/W1294.9.3` |
| W1294.9.4 | `claude-*` + `hub-*` + `claudemd-budget.test.ts` | 23 | done — `suspenders/W1294.9.4` |
| W1294.9.5 | `session-*` + `usage-*` | 17 | done — `suspenders/W1294.9.5` |
| W1294.9.6 | `store-*` + `launch-*` + `federation-*` | 17 | done — `suspenders/W1294.9.6` |
| W1294.9.7 | `service-*` (activation-fence, idle, inventory, recycle) | 4 | READY — minted by this item |
| **Total** | | **124** | = census |

## Notes the titles alone get wrong

- Loose-prefix assignments derived from branch-tree diffs, not titles:
  `fleet.test.ts` rode slice-2; `claudemd-budget.test.ts` rode slice-4;
  `servicemon.test.ts` + `remotes.test.ts` are slice-1's 9th and 10th files.
- Slice-6's title mentions `service` but its landed diff is exactly
  store+launch+federation (17 pairs) — the 4 `service-*` files are covered by
  no slice; W1294.9.7 closes that gap.
- Main still holds all 124 originals until the merge ladder lands each slice;
  "done" on the graph ≠ merged to main.

## Evidence method (re-verify)

Per child branch `B`:

    git -C <worktree-root> ls-tree -r --name-only B -- packages/suspenders/test
    # delete-set = main set minus branch set, *.test.ts only, family loose prefix

Sum of child delete-sets must equal the family census with zero overlap.
Measured at `e1ae5072`: 10 + 23 + 30 + 23 + 17 + 17 + 4 = 124.

## Conventions (carried from landed slices + the slice-6 review)

- Each slice re-pins `tests/test-framework-guard.test.ts` DOWN to the exact
  **measured** candidate count at its closing sha (the guard's own counting;
  never arithmetic from a stale base — the slice-6 FAIL receipt
  `B1-ratchet-pin-delta` is the precedent).
- Port contract (parent W1294.9): 1:1 port, titles verbatim, `@unit` default,
  `@api` when HTTP, `@ui` when GUI, test-kit adoption, delete the original
  after its port is green, branch pushed.
- W1294.9.7 inherits the contract verbatim, 4 files.

## Related

- W2279 repairs the test-framework ratchet pin on main (separate item).
- W2297 rebases `suspenders/W1294.9` over the slice landings (separate item).
