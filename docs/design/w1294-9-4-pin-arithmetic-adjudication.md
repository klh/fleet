# W1294.9.4 review FAIL B1-pin-arithmetic — adjudication record (W2358)

Reviewer claim: `tests/test-framework-guard.test.ts` PIN 653 cannot follow
from a 23-file port out of a 696 baseline (`696 − 23 = 673`), so the pin is
arithmetically wrong. Verdict: **the pin is correct; the 696 baseline was
stale.** No re-pin, no code change on the branch.

## Ground truth (git, reproducible)

| step | evidence | tracked non-decant `*.test.ts` |
| --- | --- | --- |
| pin commit | `8e84445b` set `PIN = 696`; `git ls-tree -r --name-only 8e84445b \| grep '\.test\.ts$' \| grep -v '^packages/decant/' \| grep -v '^tests/test-framework-guard.test.ts' \| wc -l` | **696** (honest then) |
| sweep-F | `578e4de2` deleted the 6 `tests/` ratchet-pair originals, no re-pin | −6 |
| sweep-H | `4fce1891` (59 files) + checkpoint `8ca8e3ab` (12) ported `packages/buckle/test`, no re-pin | net −17 |
| other lanes | `git diff --name-status 8e84445b 69157b36 -- '*.test.ts'` → `A: 3, D: 23` | +3 |
| slice-4 parent | `69157b36` — live count, PIN still 696 | **676** |
| slice-4 | `25ac883b` + `1d018c92`: 21 renames to `@unit.e2e.ts` + 2 delete/recreate pairs (`claude-restart-authority`, `claude-restart-runtime`) | −23 |
| branch tip | `1d018c92` — count vs `PIN = 653` | **653** ✓ |

The reviewer's Δ43 came from reading the PIN **constant** (696) as the live
baseline; the live count at the parent was 676, so `676 − 23 = 653` is exact.

The per-commit log view double-counts merge commits (77 deletions appear
between those commits); the tree-to-tree diff is the authoritative count.

## Verification

- Guard green on the branch worktree:
  `bun test tests/test-framework-guard.test.ts` → **3 pass, 0 fail**
  (the guard counts `git ls-files` at runtime; green proves count == 653).
- Re-review driven for the moved-base context (`base 1e34072a`) on
  `glm-5.3-flash` with the resolution notes on the item thread
  (events 93916, 93919): reviewer verdict **PASS** with
  `resolved=["B1-pin-arithmetic"]` (event 94008).

## Open defect (out of scope here, decision emitted)

The same receipt's headline was downgraded to FAIL by coverageProof
`no-coverage` — structural for pure test-port waves (no product code
changed, so no new test can fail without the change). Same override on
W1294.9.3/.9.5/.9.7; W1294.9.6 repeats the stale-pin misread
(B1-ratchet-pin-delta). NEED_DECISION 94061 carries the options.
