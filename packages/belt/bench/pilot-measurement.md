# Fleet pilot measurement — retrospective arm (W845)

Status: measured 2026-10-19, window 2026-10-06 → 2026-10-19 (the buckle
spoke-ledger era). Harness: [`pilot-measure.ts`](./pilot-measure.ts) — joins
board `/api/tasks` (work graph) × buckle `router_usage ⋈ api_keys` (ledger)
× git acceptance counts; `bun packages/belt/bench/pilot-measure.ts --help`.
Raw run artifacts land in `--out` (JSONL + summary JSON; machine-local,
untracked).

## Method

- **Item attribution**: buckle per-lane keys are named by lane sid
  (`autow845-…`, `codex-w528-probe`); `sidToItem()` maps them to work-graph
  ids. Validated: the join reproduces govdb spend for W831 exactly
  (450,731 in / 87,231 out) — two independent surfaces agree.
- **Tokens**: item `spend` (graph-spend source) or ledger join
  (ledger-join); coverage 500/569 items (87.9%).
- **Wall/agent time**: buckle-gated `spend.wall_ms/agent_ms` only —
  493/569 items (86.6%).
- **Accepted changes**: merged W-branch merges + numstat totals on the
  fleet repo (includes generated files such as bun.lock — declared).
- **Rework proxies**: FAILED count (all-time, project-wide) + fix/re-land
  children of window-DONE parents. Declared PROXIES — defect tracking is
  not instrumented.
- **Workload mix**: title-keyword heuristic, declared heuristic.

## Measured baseline (13 days, one service repo)

| surface                     | value                                    |
| --------------------------- | ---------------------------------------- |
| items DONE in window        | 569                                      |
| token coverage              | 500 items (87.9%)                        |
| wall-time coverage          | 493 items (86.6%)                        |
| accepted merges (W-branch)  | 512 (of 513 total merges)                |
| lines accepted              | +273,492 / −94,675                       |
| tokens in / out (all)       | 335.7M / 45.8M                           |
| requests                    | 111,813 (~8,600/day)                     |
| wall per item               | p50 410 min · p90 11,004 min             |
| agent time per item         | p50 57 min · p90 1,647 min               |
| rework proxies              | 13 fix/re-land children · 32 FAILED (all-time project-wide, incl. pre-window) |
| workload mix (heuristic)    | other 198 · install 94 · test 64 · agent-plane 79 · ui 44 · fix 44 · bench 34 · docs 12 |

By model group (seat-carried = claude-* via the Copilot seat):

| group            | in tok    | out tok  | cacheR   | req    |
| ---------------- | --------- | -------- | -------- | ------ |
| glm-5.3-flash    | 141.6M    | 43.8M    | 6.1M     | 107,644|
| claude-sonnet-5  | 181.5M    | 1.9M     | 0        | 3,352  |
| claude-opus-5-5  | 12.5M     | 135k     | 0        | 608    |
| claude-haiku-4-5 | 46.0k     | 1.1k     | 0        | 209    |

Notes: claude-* groups carry no cache accounting upstream (cacheR 0 —
provider-side accounting, not measured locally); glm cacheR 6.1M is the
router cache-read accounting on the local leg.

## Not instrumented (no local surface — recording, not estimating)

- **charges ($)** — needs provider pricing + retry/streaming
  reconciliation; owned by W843 (buckle usage reconciliation + monetary
  pilot budget). Tokens here are the attribution layer W843 prices.
- **seat credits** — Copilot/claude-* balances are provider-side; only
  seat-carried tokens (194.3M in / 2.0M out over the window) are local.
- **human time** — NEED_DECISION history is not queryable via CLI/board;
  no per-item operator-time surface exists.
- **hub energy/ops** — no meter on the Mac spoke or NAS/desktop hubs;
  ops cost = power + launchd cycles, unrecorded.

## Uncertainty (declared, not hidden)

- wall/agent time covers buckle-gated lanes only; pre-gate items carry
  tokens but no wall clock.
- rework/defect proxies (FAILED + fix-children) over- and under-count:
  FAILED includes tooling refusals; not all defects become fix-children.
- workload mix is a title-keyword heuristic.
- wall totals skew high (p90 = 183 h): parked/quarantined lanes accrue
  wall while doing no agent work — agent-time percentiles are the
  honest per-item signal (p50 57 min).

## Paired-arm protocol (prospective — the measurement this record enables)

The mission asks for comparable bounded changes **with and without**
Fleet lanes. No recorded manual arm exists, so the retrospective record
above is single-arm. The prospective experiment reuses the BLAM paired
discipline (bench/paired: same setup both arms, per-pair lift, declared
assumptions) with delivered code outcomes scored separately from blam's
coordination bench (blam explicitly excludes code quality):

1. **Selection**: 2n bounded changes on one service repo, comparable in
   scope class (install/test/ui/fix/docs buckets above), assigned to
   with-Fleet / without-Fleet arms before any work starts.
2. **Arms**: with = dispatch lane + review chain as today; without =
   same owner, no agent lanes, same repo law (AGENTS.md + qlty gates
   still apply — the gates are guard-rails, not the arm difference).
3. **Per-pair lift**: measure per pair (tokens, wall, human time,
   accepted-changes quality verdict from review, defects at t+14d), then
   lift = with/without per pair — never cross-pair averages.
4. **Reporting**: n ≥ 5 pairs per scope class before any claim; report
   uncertainty per pair; no equivalence or multiplier claims below that
   bar.

**Claims discipline**: nothing in this record supports a "10× token
growth" or "3–4 developer equivalence" claim — the first is a
provider-side accounting question (W843), the second needs the paired
arm that does not exist yet. This record states what the ledgers show
and nothing more.

## W845 follow-ups minted

- instrumentation for the four not-instrumented surfaces tracks under
  the item this record closes (see W845 done note); defect tracking and
  a human-time surface are the two with fleet-side fix paths.

## W846 instrumented follow-up

Two of the four gaps closed (2026-10-19, `pilot-measure.ts`):

- **human time** — NEED_DECISION emit/settle latency is now read from the
  board `decisions` table (`/api/decisions?history=1`): windowed on the
  ask, settled = `answered_ts`, CANCELLED excluded from latency, and
  per-item attribution via `task_id` (`summary.human`,
  `items[].human_time_min`). Chair, seats, energy remain external.
- **defects** — rework is classified at MINT time by the `fix`/`re-land`
  tags (`work add --tag`; split children inherit), not by title regex —
  `items.rework_children` counts tagged children of done parents only.
  Historical items stay untagged: the counter is exact from the W846
  landing forward.
