# W1305 — adversarial unminted-work audit

2026-10-26 · lane `autow1305-p98b319584008df14` · branch `suspenders/W1305`

Mission: cross-check the owner PaaS standard, the reorg plan, the workflow
adjustments log, W1294's completeness criteria, the P-wave plan, the
structural-prevention plan, and the standard's review/enforcement section
against the live work graph, and mint an item for every piece of OWED work
that no item owns. Verdict: **GAPS_FOUND — 12 gaps, all minted.**

Method: every claim below was checked against (a) the owning item's live
graph state (`work show` / `work list`), (b) the file the clause points at,
and (c) for "landed" claims, the actual main tree (`git ls-tree origin/main`,
`git show origin/main:<path>`) — not the branch that claims to have landed it.

## Gaps found and minted (12)

| # | Gap | Evidence | Minted as |
| --- | --- | --- | --- |
| 1 | Dangling-path scanner floods on fixture/classification classes (A22/O6 durable repair unminted) | docs/workflow-adjustments-2026-10-25.md A22 + O6 name no item; live post-merge scans emit fixture false positives | **W1302.8** (parent W1302, prio 1) |
| 2 | sync-harness `SOURCE_PATHS` is a hand-list with a prose verification walk — drifts silently | packages/suspenders/scripts/sync-harness.ts:32,83,224 (`export const SOURCE_PATHS = [` + comment) | **W1466** |
| 3 | speedy writes a hand-written `com.klh.buckle` launchd plist not modeled in services.yaml | packages/speedy/bin/install-fleet.ts:392-398 hand plist; services.yaml has no buckle row | **W1467** |
| 4 | Diverged spawner.ts / litellm-target.ts twins in two packages | twin files with drifting copies; no reconcile item | **W1468** |
| 5 | A18 durable repair unminted: stale Z.ai catalog timestamp strands `install.sh --wire` | workflow-adjustments A18 ("Add an install preflight or automatic refresh…"); no item | **W1469** (parent W1281) |
| 6 | W1252 `.prefer` drift 1 (exec-chain upward walk) — brief's example chain parses only re-rooted chains | W1252 filed 2 drifts; drift 1 ownerless; claimed by peer lane mid-audit | **W1470** (claimed) |
| 7 | Phase-4 reorg re-decision precondition unowned: belt→suspenders PIN rows must go first | restructure proposal phase-4 appendix HOLD + precondition; tests/fleet.import-law.guard.test.ts:80-84 still pins belt→suspenders edges | **W1471** |
| 8 | skills vendor install has no hash-parity check | skills/ vendor install path; parity unverified | **W1472** |
| 9 | Standard's "keeping review useful" mechanics unminted: round cap 3, incidents-become-evals, human-time metric | paas-engineering-standard-2026-10-23.md review section; W1303.5 landed only risk tiers/CODEOWNERS/PR template; W1303.6 is release pipeline | **W1303.7** (parent W1303) |
| 10 | W1294 failed wave unrepaired: FAILED sweeps + deleted testing-kit/ratchet guard unminted | graph: W1294.2–.18 sweeps FAILED; testing-kit + shrink-only ratchet absent from main | **W1294.19** (parent W1294) |
| 11 | A27 durable repair unminted: W833 transcript parser misses completed test output split across tool-result chunks | workflow-adjustments A27 names only W1351 (parked-ref half, integrated); parser half unowned | **W1281.8** (parent W1281, prio 1) |
| 12 | A25 durable repair unminted: installer materializes deps before staging local `@klh/*` links → npm 404 on private names | workflow-adjustments A25 (main `bbae2445` npm 404 for `@klh/blam`/`@klh/buckle`); no item | **W1281.9** (parent W1281, prio 1) |

## Clauses checked and found owned or landed (no mint)

- **Reorg phase 0**: launch janitor exists (packages/suspenders/hooks/lib/
  fleet-loop/maintenance.ts:182-194, W1247); `.gitignore` covers `*.db`,
  `*.db-shm`, `*.db-wal`, `*.lane-cache.jsonl` (`.gitignore:7-10`).
- **Amendment D faces + P3/P6**: present on origin/main.
- **W1302 class-c guards**: all 7 children done and merged.
- **Workflow rows A1–A20, A22–A24, A26**: repairs landed or owned by live
  items (A2→W1278.2, A3→W1072, A4→W1279, A5→W1280, A6→W1283/W1294.2.1,
  A9→W1288, A10→W1287, A11→W1302.3, A12→W1286.1.1, A13→W1290.1.1,
  A14→W1284.1/W1284.2.1, A15→W1293, A16→W1292.1, A17→W1304,
  A19/A23→W1313, A20→W1295, A21→W1302.2.1, A24→W1306, A26→W1302.4.1.1,
  A28→W1306.1). A22/O6 → minted (W1302.8).
- **W1303.5 deliverables** (risk tiers, CODEOWNERS, PR template): graph-DONE
  but the artifacts are NOT yet on origin/main — landing is pending under the
  open parent W1303; W1303.7's description forbids flipping the coverage
  matrix LANDED until the artifacts actually land. Not a new gap; tracked.
- **P-wave rollout surface**: P1 (W1303.1.1.1 merged at `77f82b47`), P3, P6
  on main; P2/P4/P5 ride the open W1303 umbrella (P5 = W1303.5 landing).
- **Standard clause map**: every standard section maps to a coverage-matrix
  row (docs/paas-compliance-coverage.md) or a dispositions row
  (docs/standard-dispositions.md). Row 8's "No migration item exists or is
  planned" is stale against live W1294 — adjacent wording fix already claimed
  under W1301.1.1, not re-minted.

## Minted-but-stuck facts (reported, not re-minted)

- **W1266** FAILED — FAILED items have no reclaim path; needs `work retry`.
- **W1294.2–.18** sweeps FAILED (superseded by W1294.19's repair plan).
- **W1303.1.4** FAILED, superseded by W1303.1.9 (already minted upstream).
- **Dispositions row 8** stale wording — W1301.1.1 (claimed) covers the fix.
