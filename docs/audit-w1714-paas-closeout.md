# W1714 — PaaS-standard close-out audit (P1–P6)

Read-only review, 2026-10-26, at `origin/main` = `b7d773f0`. Main moved to
`fdc5e073` (the W1294.19 merge) during the audit; every unmerged SHA below was
re-checked against it and no verdict changed. Inputs: the owner
standard (repo copy `docs/paas-engineering-standard-2026-10-23.md`; the
Downloads original was not readable from the lane, so byte-equality with it is
unverified), `docs/restructure-proposal-2026-10-23.md`,
`docs/standard-dispositions.md`, the work graph and `work.review` receipts.

Every landing below is checked by git ancestry, never by a DONE statement:

- **DONE** — the work graph records a `result_sha`.
- **pushed** — an `origin/*` branch contains the SHA.
- **merged** — ancestor of `origin/main` `b7d773f0`.
- **installed** — ancestor of the harness receipt revision `19824028`
  (41 commits behind main).
- **deployed** — ancestor of the hub pin `fleet-2026-10-25-a69f2c4c`
  (149 commits behind main; it contains no P-series commit).

## Verdict per row

| Row                | Item           | SHA                 | pushed | merged | installed | Verdict                                  |
| ------------------ | -------------- | ------------------- | ------ | ------ | --------- | ---------------------------------------- |
| P1 belt            | W1303.1.2      | c6f33618            | Y      | Y      | Y         | landed                                   |
| P1 suspenders      | W1303.1.3      | b347d075            | Y      | Y      | Y         | landed                                   |
| P1 rollout         | W1303.1.6      | 8826faf8            | Y      | Y      | -         | merged, not installed                    |
| P1 rollout         | W1303.1.7      | 42f66ce0            | Y      | Y      | -         | merged, not installed                    |
| P1 rollout         | W1303.1.8      | 756fb519            | Y      | Y      | -         | merged, not installed                    |
| P1 rollout         | W1303.1.10     | 346d14ed            | Y      | Y      | -         | merged, not installed                    |
| P1 buckle          | W1303.1.1      | 86908c9d            | Y      | -      | -         | GAP — DONE, unmerged                     |
| P1 small packages  | W1303.1.9      | 95da80fb            | Y      | -      | -         | GAP — DONE, unmerged; 11 rounds all ERROR |
| P1 completion      | W1303.1.5      | —                   | —      | —      | —         | GAP — plan CLAIMED, open                 |
| P2 HTTP kit        | W1303.2 / .2.1 | 10f1ccd4 / 7fc06769 | Y      | Y      | Y         | landed                                   |
| P3 resilience      | W1303.3        | 4db0f091 / d3c0a839 | Y      | Y      | Y         | landed                                   |
| P4 schema-first    | W1303.4        | df2a3f0f            | Y      | Y      | Y         | landed                                   |
| P5 proof fix       | W1303.5.1      | dca36d6b            | Y      | Y      | Y         | landed                                   |
| P5 review contract | W1303.5        | 592a26a2            | Y      | -      | -         | GAP — DONE, unmerged                     |
| P5 approval repair | W1308          | f7f10d0d            | Y      | -      | -         | GAP — DONE, unmerged                     |
| P6 pipeline        | W1303.6        | d69ec274            | Y      | Y      | Y         | landed; the cut itself is W1311          |
| Round cap          | W1303.7        | 884f075d / 4bfc1839 | Y      | Y      | -         | merged, not installed                    |
| Parent             | W1303          | 8910d202            | Y      | -      | -         | DONE premature (gap 4)                   |

No row is deployed. **Verdict: the reorg has not landed.** P2, P3, P4 and the
P6 pipeline are merged and installed. P1 and P5 are open. Nothing from P1–P6
is on a hub.

## Gaps — causal blockers first

1. **CI has executed nothing since 2026-10-11 — W1759 (minted).** actionlint
   1.7.12 on `.github/workflows/ci.yml`: `:190`, `:242` and `:243` use the
   `runner` context in job-level `env` (3c00f453); `:310` puts `matrix`
   outside `strategy` (ed290171, W772.2). The latest main run (40402075749
   at b7d773f0) is a "workflow file issue" with 0 jobs; 0 of 983 runs are
   green. Every "in CI" clause of the standard (`:175`, `:198`, `:257`,
   `:587`) is unenforced, and so is the root AGENTS.md claim that CI gates
   every commit.
2. **No gate runs the P1 check tools.** `.githooks/pre-commit` runs scrub
   only. `.githooks/pre-push` runs post-commit `--full`, `gen-openapi --check`
   and scrub. The merge ladder
   (`packages/suspenders/hooks/lib/fleet-loop/merge.ts:443-516`) is a git
   merge plus a `qlty` fix, with no test or law gate. At b7d773f0:
   - `packages/suspenders/scripts/check-versions.ts`: 13 findings.
   - `scripts/check-deps.ts`: 6 findings.
   - `packages/suspenders/scripts/check-pack.ts`: 7 of 9 packages fail,
     including the packed suspenders `coord`/`work`/`dispatch` bins.

   Owners: W1303.1.5 (P1 completion plan) and W1475 (reach-in pins), under
   the W1249 ratchet. W1475 went DONE at e372766b during this audit (#78523):
   pushed, not merged. Its own Phase 4 verdict is still HOLD, with 13
   suspenders→belt rows left.
3. **The review pipeline cannot pass clean branches.** Paths are under
   `packages/suspenders/hooks/`.
   - **Coverage proof: "test restore failed".** `bin/review-lane.ts:413-416`
     takes test paths from `git diff --name-only main...<branch>`, which
     includes deleted files. `:475-477` then cannot `git checkout --` a
     deleted path. Every branch that deletes a test file, or renames one
     beyond rename detection, gets ERROR on every review:
     - W1306 c2ff563d: 25 buckle `*.test.ts` files become `*.e2e.ts`.
     - W1294.17.1.3 d155e637: 12 files (#78419).

     Fix: add `--diff-filter=d` to that diff. Owner: W1306.1 (READY). Its
     description scopes the W1306 branch, but the fix belongs in the
     machinery.
   - **Coverage proof: test-only diffs grade FAIL.** `bin/review-lane.ts:417-418`
     skips only when no test file changed. A diff that adds tests and nothing
     else reverses to main plus those tests, they pass, and `no-coverage`
     grades FAIL on every round. W1217.1 (#78532, commit f0113730, one new
     test file, reviewer PASS) is one. Fix: skip when the diff has no non-test
     path. Same owner, W1306.1.
   - **Wire-model guard — W1760 (minted).** `lib/gates/wire-model-check.ts:27-36`
     calls a dated snapshot id a mismatch. `bin/review-lane.ts:623-625` grades
     every mismatch FAIL, and `lib/gates/review-round-cap.ts:78` counts it as a
     round. W1241 commit 73ebe9be failed this way on three bases (207cd098,
     b7d773f0, fdc5e073: #78210, #78345, #78477), always `claude-haiku-4-5`
     against `claude-haiku-4-5-20251001`. That spends its whole cap of 3. In
     #78405 (W1302.1.1) the reviewer said PASS and the proof passed, yet the
     receipt was FAIL. W1302.1.1 has since passed (#78519).
   - **Leg availability.** 503/429 waves and empty replies produce ERROR
     receipts, which retry without bound by design
     (`lib/gates/review-scheduler.ts:300-304`, W1243):
     - W1303.1.9: 11 rounds, all ERROR (8×503, 2×429, and #77329 with
       "no bun test summary" on an LLM PASS).
     - W1303.5: about 20 rounds, mostly ERROR.
     - W1107.1.2: 7 of its last 8 receipts are ERROR.
     - The scoped review-key mint was refused (#78355).

     This is routing and operator capacity, not code. Flagged, not minted.
4. **W1303's DONE is premature.** Its result 8910d202 (coverage matrix plus
   `.editorconfig`) is pushed but not merged (review PASS #78241). The summary
   says the manifest repairs and P5 landed. At b7d773f0, W1303.1 is SHATTERED
   with W1303.1.5 CLAIMED, and W1303.5.2 is CLAIMED. The controller decides
   (see the handoff).
5. **Installed and deployed lag.** The installed generation 19824028 lacks
   W1303.1.6/.7/.8/.10 and the W1303.7 round cap, so the live scheduler does
   not cap the W1303.5 FAIL loop. Hubs run `fleet-2026-10-25-a69f2c4c`, so no
   P-series commit is deployed. Owner: W1311 (CLAIMED) for the cut and the hub
   deploy. The local install is an operator step.
6. **The root law suite is red on W902 wall-clock.**
   `tests/law-guards.test.ts:188-190` fails at b7d773f0 (10 pass, 1 fail) on
   6 files.
   - W1107.1.2 (ce494b68: DONE, never pushed) repairs the 4 board-html files
     and `dashboard-model-access.js`.
   - `packages/belt/bin/dashboard-topology-hubs.js:295` arrived later
     (056dbce4, W858.7.32 slice 3, 2026-10-24) and is merged, installed and
     deployed.

   Owner: W1107 (SHATTERED). W1107.1.2 must be rebased over 056dbce4 and
   pushed.
7. **The dispositions ledger is stale — W1761 (minted).** Rows 6, 7 and 9
   still read GAP although their owners merged. Row 8 is contradicted by W1294
   (FAILED plan) and by W1238.2 (d8563e1c: DONE, never pushed). There is no
   CI row.
8. **The pre-push suite flakes under lane load and blocks pushes.**
   NEED_DECISION #78315 (consult C155) is open; reuse it.

## Dangling-path flood (owner note #78436)

The 415 READY "Repair dangling path" items are 95% of the READY queue, and
none is claimed. The flood is still running. Local main 0441c055 (the
W1302.1.1 merge, not yet on origin when checked) minted W1763–W1765 while this
audit was being committed: the message string `no lanes in .fleet/lanes.json`,
the bare name `biome.json`, and `f.txt` inside a test file. The merged rules
reject all three. Every `code.dangling-path` event (415) was re-judged against
the merged W1302.2.1 rules
(`packages/suspenders/hooks/lib/fleet-loop/dangling-paths.ts:57-65,106-123`)
on the `origin/main` tree:

| Class                                       | Items | Examples                                                       |
| ------------------------------------------- | ----- | -------------------------------------------------------------- |
| literal inside a test or fixture file       | 295   | W1754 `@klh/telemetry/*`                                       |
| not a reference form (bare name, extension) | 117   | W1750 `.mjs`, W1490 `wire.ts`, W1628 (quote desync)            |
| target under a runtime dir                  | 1     |                                                                |
| residual: the merged extractor still emits  | 2     | W1705 (`belt-bin-overlay.ts:303` JSDoc), W1614 (nested quote)  |
| confirmed dangling edge                     | 0     |                                                                |

Why the pool keeps growing:

1. **The live scanner is the unfixed one.** Generation 19824028 runs W1302.2
   (a1d10253). The fix d59e6b1e is merged but not installed, so at least 176
   items came from merges that already contained it (b7d773f0, 207cd098,
   8129b4df …).
2. **The hold lifted on DONE, not on install.** W1473 released dispatch when
   W1302.2.1 went DONE, and it only covered W1316–W1464. 273 items fall above
   that range.
3. **Minting is per literal.** `bankDanglingRef` (`:243-294`, called from
   `merge.ts:299-304`) dedupes by title only and has no per-merge cap. One
   merge (d9639242) minted 92 items.

Owners:

- **W1762 (minted, one aggregate item):** a rejudge verb that re-runs the
  current classifier and supersedes rejected items with the classifier SHA as
  the reason, plus a hold keyed on the installed receipt revision.
- **W1302.8 (READY):** extractor precision — the 2 residual items, and the
  quote-desync class behind W1628 — plus edge dedupe. W1762 takes over its
  W1394–W1463 cleanup clause.
- **Install of d59e6b1e or later:** stops new mints.

No genuine edge was found; surviving items keep their existing edges.

## Noise (not causal)

- The W902 matcher flags `Number(n).toLocaleString()` at
  `packages/belt/bin/dashboard-model-access.js:64,68` as a Date render. It is
  a false positive.
- `.klh-done.md` is tracked at the repo root. It is lane debris.

## Controller handoff (guarded)

For coordinator 1a536a25. W1714 merged nothing, deployed nothing and bypassed
no gate. Every item named here keeps its owner.

1. **Hold dispatch of the dangling-path pool** until W1762's rejudge has run
   and an install of d59e6b1e or later has landed.
2. **Reopen or supersede W1303.** Its DONE sits on an unmerged SHA and
   overstates; P1 (W1303.1.5) and P5 (W1303.5.2) are still open. W1761 can
   fold into a reopened W1303.
3. **Edges to apply.** These items are controller-owned, and W1714 did not
   change them:
   - W1303.1.5's CI wiring depends on W1759.
   - Re-review W1241 only after W1760. Its three mismatch FAILs fill the cap,
     so W1760 must discount them, or W1241 needs one more round of cap.
   - Widen W1306.1 to both machinery fixes (deleted paths at
     `review-lane.ts:413`, test-only diffs at `:417`). Then re-review W1306,
     W1294.17.1.3 and W1217.1.
   - Rebase W1107.1.2 over 056dbce4 and push it.
4. **Merge order on the ladder:**
   1. W1303.1.1, plus W1303.1.9 once review legs are available.
   2. W1303.1.5.
   3. W1303.5.2 (P5 + W1308).
   4. The W1311 cut.
   5. Install.
5. **Operator:** review-leg capacity (503/429 on the glm review legs) and the
   refused scoped-key mint (#78355).

## Reproduce

- **Ancestry:** run `git merge-base --is-ancestor <sha> origin/main`. Repeat
  against the `revision` in `~/.claude/hooks/suspenders/harness-receipt.json`
  and the `version` hub pin in `~/.config/klh/stack.json`.
- **CI:** `actionlint .github/workflows/ci.yml`.
- **Law suite:** `bun test tests/law-guards.test.ts`.
- **Wire model:** `wireModelMatch("claude-haiku-4-5", "claude-haiku-4-5-20251001")`
  returns `mismatch`.
- **Dangling pool:** `coord events --kinds code.dangling-path --last 1000`,
  classified with the rules at `dangling-paths.ts:57-65`.
