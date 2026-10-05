# Grid coordination research — mining volunteer computing for the fleet

W437 · 2026-10-05 · research only, no code landed

What BOINC-era volunteer computing (SETI@home, Folding@home, Sheep-it, BURP)
and their modern descendants (Dask, Ray) solved about coordinating
unreliable, intermittently-connected executors, and what the klh fleet
should and should not build into the work graph, capsule protocol and
reclaim machinery.

Baseline read: `packages/suspenders/hooks/bin/work.ts`,
`packages/suspenders/hooks/coord/bus.ts`, `packages/suspenders/hooks/coord/facts.ts`,
`packages/suspenders/scripts/dispatch-next.ts`,
`packages/suspenders/hooks/lib/lane-liveness.ts`, root + suspenders CLAUDE.md.

## The one-paragraph verdict

The fleet has already independently reinvented the load-bearing half of
volunteer-computing coordination: capsules are BOINC checkpoints
(`boinc_time_to_checkpoint` / fraction-done), pause/resume + `resume-session`
is app preemption, per-item worktrees + same-sid resume is Ray's
locality-aware leasing, and the W60 dep-merge ancestor gate is a result
validator ("done ≠ merged"). The two mechanisms the fleet is genuinely
missing are both about _unreliable executors_: a poison-item quarantine
(Dask's three-worker-death rule; today a fruitless item loops
dispatch → death → reclaim → READY forever) and an executor trust tally
(BOINC adaptive replication's CV counter; today `execPick` remembers
attempt index only within one item's life, never across items). Both are
adopt-now, both are small, and both respect the owner law that a `.prefer`
MUST chain is never silently rerouted. Credit economies, majority voting,
and speculative duplication are correctly skipped for a single-owner fleet
of trusted executors — with the noted exceptions of flaky local-llm models
and mangle-prone harnesses, which is exactly where the two adopt-now items
apply.

## Ranked ideas

| #   | Idea                                            | Grid precedent (primary ref)                                                                                                                                                                                    | Fleet analog that exists today                                                                                                                 | Verdict                       | Integration sketch                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Poison-item quarantine (3-strike doom)          | Dask Resilience: a task-killing function is "marked as 'bad' after it kills a fixed number of workers (defaults to three)" → `KilledWorker`; BOINC retires a work unit past `max_error_results` (Job-templates) | `work reclaim all` re-READYs an item forever; `execPick` clamps `idx = min(attempt, chainLen - 1)`, so the same tail executor eats every retry | **adopt-now**                 | `work_items` += `fail_count`, `last_claim_sha`; `work reclaim` (incl. `all`) increments when the claim yielded no new commit on the item branch; ≥3 → FAILED with note + `coord emit NEED_DECISION`; dispatch-next skips doomed items unless forced; real progress resets the counter |
| 2   | Executor trust tally (adaptive replication)     | BOINC Adaptive Replication: per-(host, app-version) consecutive-valid counter CV(H,V), untrusted below 10, trusted with probability 1 − 1/CV, reset to zero on an invalid result                                | Attempt chain advance is per-lane only; copilot metering (`lane.<sid>.usage`) measures spend, not reliability                                  | **adopt-now (measure-gated)** | Facts `executor.<host>.<name>.cv` derived from the EXISTING events log (`work.done` with an on-main sha increments; `reclaim`/`fail` resets); `execPick` reorders the DEFAULT ladder only — never a `.prefer` MUST chain (W228)                                                       |
| 3   | Soft deadlines + EDF overlay                    | BOINC `delay_bound` per work unit; ClientSched runs earliest-deadline-first for results "in danger"; Kondo/Anderson/Vila 2007 measured ~10% from early miss detection                                           | `priority DESC, id` ordering; no time dimension anywhere                                                                                       | adopt-later                   | `add --deadline`; `work ready` floats in-danger items above the FIFO pool; monitor flags; pause/resume carries the handoff                                                                                                                                                            |
| 4   | Fraction-done progress signal                   | `boinc_fraction_done` (monotonic 0..1) reported alongside checkpoints                                                                                                                                           | Capsule carries done/next/checkpoint; liveness = transcript mtime (15-min window)                                                              | adopt-later                   | `coord capsule set --pct`; monitor can flag a live-but-stalled lane (fresh transcript, no pct/commit movement) before death                                                                                                                                                           |
| 5   | Adaptive chunk sizing by executor capacity      | Sheep-it splits one frame into 64 parts under a 20-min/part budget; SETI@home sized work units at 107 s of tape against a client-day                                                                            | `work split` children are authored titles with no size model                                                                                   | adopt-later                   | `split` learns per-child `--est`; dispatch-next bin-packs estimates against TARGET concurrency                                                                                                                                                                                        |
| 6   | Result verification by redundancy / quorum      | BOINC JobReplication: `min_quorum` / `target_nresults`, validator runs at quorum, late results compared against the canonical; SETI@home computed every unit redundantly (CACM 2002)                            | W60 dep-merge ancestry gate + qlty/tests gates + paired-lane verify (writer, verifier, claim-owner closes)                                     | skip (for code)               | see skip list — quorum belongs on research claims, not gate-verified code                                                                                                                                                                                                             |
| 7   | Speculative execution (replicate ahead of need) | `target_nresults > min_quorum`; late arrivals compared against the canonical result                                                                                                                             | None, by design                                                                                                                                | skip                          | 2x compute for straggler insurance a trusted-executor fleet does not need                                                                                                                                                                                                             |
| 8   | Checkpoint/restart + preemption                 | `boinc_time_to_checkpoint` / `boinc_checkpoint_completed`, atomic output via MFILE flush, client time-slicing                                                                                                   | Capsule protocol + pause/paused/resume/resumed + `resume-session` ownership rebind; mirror export is an atomic rename                          | skip — already built          | Grid confirms the design; nothing to mint                                                                                                                                                                                                                                             |
| 9   | Locality-aware scheduling / spillback           | Ray: prefers "the node with most object bytes local"; locality-aware leasing with spillback candidate sets (ray-project/ray #12812)                                                                             | Per-item worktrees keep state in place; resume re-dispatch reuses sid + worktree; `resolveHub` walks candidate endpoints                       | skip — already built          | Revisit hub-locality scoring only after the enterprise hub overlays land (W422.9)                                                                                                                                                                                                     |
| 10  | Host-class equivalence isolation                | BOINC Homogeneous Redundancy: hosts partitioned into numerical equivalence classes so strict-equality comparison is valid                                                                                       | Executor/model classes in the `.prefer` chain; local-llm swarm tiers (:8901 coder, :8903 reason…)                                              | folded into #2                | Treat host × model as the trust-tally class, mirroring CV(H,V); full HR machinery (80 classes, census) is overscaled here                                                                                                                                                             |
| 11  | Credit economy / turnaround bonuses             | BOINC Cobblestone credit; Folding@home Quick Return Bonus (passkey + ≥80% return rate); Sheep-it points with a 30% self-render discount                                                                         | Copilot spend metering only                                                                                                                    | skip                          | See skip list — no adversary to pay; the measurable kernel is already derivable                                                                                                                                                                                                       |
| 12  | Fair-share allocation across classes            | BOINC `hr_allocate_slots` + census task: work-cache slots proportional to per-class processing rate                                                                                                             | Scope claims (`claims` table) + TARGET = 8 lanes                                                                                               | skip                          | Single owner orders priorities; revisit only for multi-tenant hubs                                                                                                                                                                                                                    |

## Adopt-now detail

### A. Poison-item quarantine — a doom counter on the work graph

The failure mode: a READY item whose lane dies without producing a commit.
Today the loop is `dispatch → lane dies → reclaim → READY → dispatch`, with
`execPick` clamped to the same last chain entry, and nothing records that
this item has eaten three lanes already. Dask caps this exactly: a function
that kills three workers is marked bad and raises `KilledWorker`; BOINC
retires a work unit that accumulates more than `max_error_results` error
results.

Mintable work item:

- `work_items` gains `fail_count INTEGER DEFAULT 0` and
  `last_claim_sha TEXT NULL`.
- On `work reclaim <id>` and inside `work reclaim all`: read the item
  branch head in the item worktree (same spawn-args pattern as the W60
  ancestry probe; fail-open when there is no worktree). If head == the sha
  seen at claim start (or there is no commit at all), increment
  `fail_count`; else progress happened — reset `fail_count` to 0.
- When `fail_count >= 3` (Dask's default is the precedent): `FAILED`, note
  "doom: 3 fruitless claims", `emit("work.failed", id)` (already exists)
  plus a `coord emit NEED_DECISION --to <owner>` — an item that eats lanes
  is an owner decision, not an automagic loop.
- dispatch-next: skip READY items with `fail_count >= 3` (defense in
  depth; FAILED items are already outside the pool).
- `work done` clears the counter. The `.workgraph.jsonl` mirror column
  list must gain the two fields (it enumerates columns explicitly).
- No new tables; two columns + reclaim/done logic + a dispatch filter.

### B. Executor trust tally — BOINC's CV counter over fleet events

BOINC's adaptive replication keeps `CV(H, V)` = consecutive validated
results per host per app version; hosts below 10 are untrusted, trusted
ones are chosen with probability 1 − 1/CV, and one invalid result zeroes
the counter. The fleet equivalent needs no new infrastructure because the
events log already carries the verdicts: `work.done` with a sha the W60
ancestry probe confirms is on main is a validated result; a reclaim or
fail is an invalid one. The classes that matter here are exactly where the
owner said credit systems DO apply: flaky local-llm models (pins that die
on client-side `unrecognized_model`) and mangle-prone harnesses (the W223.2
copilot brief gate exists because of this).

Mintable work item (measure-gated, per the no-new-infra-without-measured-need
law):

- Step 1 (measure): a small reader that folds recent events into facts
  `executor.<host>.<name>.cv` — increment on verified done, reset to zero
  on reclaim/fail. No behavior change; board/monitor can display it.
- Step 2 (act, only when the data shows skew): `execPick` sorts the DEFAULT
  ladder (`enabled_executors` + fallback models) by CV descending, and
  orders `--fallback-model` tails the same way. A `.prefer` MUST chain is
  NEVER reordered — W228 owner law is the boundary this must not cross,
  the same way BOINC trust only steers default scheduling, never explicit
  project requests.
- Storage: facts, versioned by `coord fact set` semantics; no schema
  change.

## Skip list (with reasons)

- **Credit economy / points (BOINC Cobblestone, Sheep-it, FAH).** The
  credit system exists to make untrusted strangers honest — claimed vs
  granted credit, half-credit for invalid results (World Community Grid
  documents the halving), 30% self-render discounts against farming. The
  fleet has one payer and owner-vetted executors: there is no adversary to
  meter. Where the ideas DO apply is already scoped into adopt-now item B:
  per-executor reliability facts for flaky local-llm models and unreliable
  lanes. FAH's Quick Return Bonus (passkey, ≥10 bonus-eligible units, ≥80%
  return rate) reduces to per-lane turnaround stats — derivable from
  `lanes.json` timestamps when anyone wants them, not infrastructure.
- **Majority voting / quorum for results.** Code results already have
  validators — qlty, tests, the W60 dep-merge ancestor gate — and a second
  lane re-deriving the same diff doubles cost without adding certainty.
  Quorum belongs where there is no deterministic validator: contested
  research claims (the journalism rule: corroboration, right of reply) and
  flaky-model text outputs. The paired-lane protocol (locks pick the
  writer, findings transfer via SendMessage, claim-owner verifies and
  closes) already is a two-person quorum with an owner judge.
- **Speculative duplication.** `target_nresults > min_quorum` insures
  against stragglers on a network of flaky volunteers. On this fleet the
  insurance premium is a whole lane; skip.
- **Checkpoint/restart.** Already built: capsule = checkpoint packet with a
  mandatory checkpoint sha (`paused` refuses without one — stricter than
  BOINC, which only asks the app to checkpoint at safe points);
  `resume-session` moves ownership atomically like BOINC's restart reading
  `APP_INIT_DATA::starting_elapsed_time`. The grid is the precedent, not
  the backlog.
- **Locality-aware scheduling.** Ray's locality-aware leasing keeps tasks
  near their object bytes; the fleet keeps lanes near their worktrees
  (per-item worktrees, same-sid resume, `resolveHub` candidate walk on
  spillback — hub unreachable → local belt, surfaced, never silent). Only
  worth revisiting when multi-hub overlays share object stores (W422.9).
- **Homogeneous redundancy as a subsystem.** The insight (compare only
  like-for-like executors) survives as the class key in adopt-now item B;
  the machinery (80 equivalence classes, census-driven cache-slot
  allocation) is sized for 500k volunteers, not 8 lanes.
- **Chunk sizing / deadlines / fraction-done (rows 3–5).** Adopt-later
  with explicit triggers: deadlines when the fleet serves external SLAs
  (IKEA missions), `--pct` when stall-reclaim (live transcript, zero
  progress) is observed in practice, `--est` when split children start
  being dispatched against a saturated TARGET pool.

## Sources

Primary (verified against the source):

- BOINC Job replication — min_quorum/target_nresults mechanics, canonical
  result, late-result comparison: <https://github.com/BOINC/boinc/wiki/JobReplication>
- BOINC Adaptive Replication — CV(H,V), trust threshold 10, probability
  1 − 1/CV, reset on invalid, 50%→5-10% overhead rationale:
  <https://github.com/BOINC/boinc/wiki/Adaptive-Replication>
- BOINC Homogeneous Redundancy — equivalence classes, HR types, stranded
  jobs: <https://github.com/BOINC/boinc/wiki/Homogeneous-Redundancy>
- BOINC Job templates — `rsc_fpops_est`, `delay_bound`, `min_quorum`,
  `target_nresults`, `max_error_results`:
  <https://github.com/BOINC/boinc/wiki/Job-templates>
- BOINC API for native apps — `boinc_time_to_checkpoint`,
  `boinc_checkpoint_completed`, `boinc_fraction_done`, MFILE:
  <https://github.com/BOINC/boinc/wiki/API-for-native-apps>
- Dask Resilience — bad function after three worker deaths,
  `KilledWorker`, scheduler reroute on worker death:
  <https://distributed.dask.org/en/stable/resilience.html>
- Dask configuration — work-stealing, retries before a task is "bad":
  <https://docs.dask.org/en/stable/configuration.html>
- Ray scheduling — node with most object bytes local preferred:
  <https://docs.ray.io/en/latest/ray-core/scheduling/index.html>; locality-aware
  leasing: <https://github.com/ray-project/ray/issues/12812>
- BOINC ClientSched — EDF for results in danger, REC-based work fetch:
  <https://github.com/BOINC/boinc/wiki/ClientSched>
- Kondo, Anderson, Vila — "Performance Evaluation of Scheduling Policies
  for Volunteer Computing" (e-Science 2007), ~10% from EDF simulation:
  <https://boinc.berkeley.edu/boinc_papers/client_sch_eval/client_sch_eval.pdf>
- SETI@home — Korpela et al. 2025 front end (recorder, splitter):
  <https://arxiv.org/abs/2506.14718>; Anderson et al. 2025 data analysis
  (work unit = 107 s of tape, ~7.69M units), redundant computation +
  deadlines per the CACM 2002 experiment paper
- Folding@home — "Points, stats & passkey": per-WU timeout (reassign) vs
  deadline (no credit), QRB requirements:
  <https://foldingathome.org> (Points, stats & passkey page)
- Sheep-it — single frame split into 64 parts, 20-min/part budget:
  <https://www.sheepit-renderfarm.com> (news, Sept 2013)

Leads (unverified, do not rely without a source):

- Sheep-it ban/verification specifics for bad renders — community
  descriptions only; no official doc surfaced.
- "LambdaLab-style grids" from the brief — nothing verifiable found under
  that name; treated as unspecified.
- A BURP/"Chaos renderer" paper — not found; BURP is documented as a
  BOINC-based Blender render project (Wikipedia; Haaranen 2009 and
  Seppälä 2010 theses are secondary). BOINC's own replication/credit
  mechanics, which BURP inherited, are covered above from primary docs.
- BOINC `max_error_results` numeric default — parameter name verified in
  Job-templates; the default value was not stated on the page and is not
  relied on here.
