# W2312 — Kueue queueing patterns adoptable into fleet dispatch/capacity

Research note (2026-10-30). Source: kueue.sigs.k8s.io + kubernetes-sigs/kueue
(v1beta2 API, `pkg/scheduler/scheduler.go`), cross-read against fleet's
dispatch/capacity/liveness code. Every "today" claim below was verified on this
machine's live governor.db (`dispatch intent inspect`, SQL counts) — evidence
inline.

## Kueue in one paragraph

Kueue separates **queueing** from **execution**: workloads wait in local
queues; a central scheduler runs a batched cycle — snapshot cluster quota,
nominate heads, preempt if needed, admit. Admission is a **two-phase
commit**: `QuotaReserved` (capacity held) → `AdmissionChecks` (external
readiness gates) → `Admitted` (the pod spec is finally applied). Backward
transitions are first-class: Evicted workloads carry `requeueState
{count, requeueAt}` — exponential backoff (60s × 2^n + jitter, cap 3600s);
`backoffLimitCount` exhaustion **deactivates** the workload instead of
retrying forever.

## The concept map

| Kueue                        | Fleet today                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| Workload Pending             | work_items READY                                                         |
| QuotaReserved                | lane_launch_intents PREPARING/REGISTERED ("held")                        |
| Admitted                     | live lane (`work lanes` verdict true)                                    |
| Finished                     | DONE / CANCELLED / SUPERSEDED / FAILED                                   |
| ClusterQueue quota           | dispatch `--target` (steady posture; Plaid = no numeric ceiling)         |
| AdmissionCheck               | buckle-front probe, route audit, grinder breaker, cred scope — scattered |
| requeueState backoff         | `dispatch.launch-backoff.<hash>.<item>` facts (5-step ladder + jitter)   |
| backoffLimitCount            | SUSPENDERS_LANE_MAX_ATTEMPTS (default 3) + lane_launch_budgets           |
| Eviction → Finished          | parkExhaustedLaunch / quota-sweep reclaim                                |
| StopPolicy Hold/HoldAndDrain | dispatch hold (`.fleet/dispatch-paused.json`, named + TTL, W1196)        |

The gap is not vocabulary — fleet already has every slot. The gap is
**explicit terminal transitions for launch intents** and **state-coupled
capacity accounting**. Kueue's workload object moves through a state machine
with terminal exits; fleet's intent row has exactly one terminal writer
(FAILED, set only by the dispatcher's own unwind) and no exit at all on work
completion.

## Adoptable patterns (ranked)

### 1. Launch intents get a lifecycle state machine — the top adoption

Kueue lesson: reservation ≠ admission, and both have **explicit terminal
transitions**. Fleet's `lane_launch_intents` violates both halves.

Live evidence (this machine, 2026-10-30):

- 1,494 intent rows; 1,403 `REGISTERED` whose item is terminal on the graph
  (DONE/SUPERSEDED/CANCELLED/FAILED/SHATTERED) — **94% of the table is
  finished work never transitioned**.
- Every dispatch cycle calls `heldLaunchItems` → `inspectLaunchIntent` over
  the whole non-FAILED population; capacity math walks garbage rows.
- Concrete wedge: **W417.4** — DONE since 2026-10-07, intent still
  `REGISTERED`, its pid (58349) since **reused by an unrelated live claude
  lane**, and its recorded birth is the legacy `ps lstart` format that
  `compareProcessBirth` structurally cannot compare → verdict `unknown`
  forever → `heldLaunchItems` counts it against today's held set. Measured:
  held set = 6, of which 5 are the genuinely live lanes; W417.4 is a
  23-day-old phantom holding ~17% of steady target 6.

Adoption: `PREPARING → REGISTERED → (ADMITTED | FAILED | FORGOTTEN)`. The
work verbs that close/abandon an item (`work done/fail/release/reclaim`,
quota-sweep) transition the intent to `FORGOTTEN` (Kueue's term for
queue-forget) in the same transaction — the intent row can never outlive its
work item. `inspectLaunchIntent` stays the ONLY liveness oracle; the state
machine never guesses death, it only records that the work ended.
This kills the W417.4 class structurally and shrinks the table to
active work (~7 rows today instead of 1,494).

### 2. Reservation vs usage: held ≠ running ≠ pending

Kueue counts `pendingWorkloads`, `reservingWorkloads`, `admittedWorkloads`
separately; borrowing is bounded by `borrowingLimit` distinct from
nominalQuota. Fleet's steady capacity mixes them: `canAttemptRefill` compares
`live + heldSlots + dispatched` against one target (dispatch-next.ts:505),
and `heldSlots` includes structurally-unknown intents (pattern 1). With
intents terminal-coupled, add the counters to `work report` and the board
(pending/held/admitted) — the operator sees saturation, not just occupancy.
Keep ONE steady target initially (Kueue's nominalQuota analog:
`fleet_loop.dispatch_target`, default 6); a separate held-cap (max
in-flight launches) is a later refinement, config-over-code.

### 3. BestEffortFIFO: an unadmittable head must not block newer fitting work

Kueue's default QueueingStrategy: heads that cannot fit are set aside with a
backoff note; newer workloads that fit are admitted past them. Fleet's
READY pool is strict FIFO by id (dispatch-next.ts:552 "id order = FIFO
priority"); one undispatchable head (unmet requires, capability-starved,
route held) can absorb the cycle's attention — dispatch-next already
special-cases this (capability pre-filter W619, item-local deferrals
W1145), which is BestEffortFIFO re-derived locally. Adoption: make it a
rule — a refused item gets an item-local deferral with a requeueAt
(backoff ladder), and the refill continues down the pool. Do NOT adopt
StrictFIFO (head-of-line blocking is a feature for Kueue's fairness
contract, not for a research fleet).

### 4. Requeue with exponential backoff + limit → terminal, not eternal

Fleet already has the machinery — it's split across three shapes that don't
meet: launch-backoff facts (5-step ladder 5s→55s + jitter, capped Retry-After
15min), launch budgets (default 3 attempts), and the graph's FAILED state +
`work retry`. Kueue's shape is cleaner: one `requeueState {count, requeueAt}`
on the workload, limit exhaustion → **deactivation** (terminal, surfaced),
never a silent eternal loop. Adoption: budget exhaustion (parkExhaustedLaunch)
should land the item FAILED on the graph (feeding `work retry`'s existing
recovery path) rather than parking it READY-invisible waiting for a NEED_DECISION;
today's W787 quarantined-READY class is Kueue's "deactivated" re-derived.
Keep fleet's honest-evidence doctrine: requeue scheduling stays
attempt-scoped (W1165) — old transcript bytes never schedule a wall.

### 5. Admission checks as a uniform gate pattern

Kueue AdmissionCheck states: Pending | Ready | Retry | Rejected. The
distinctive semantics are the FAILURE states: **Retry** = release the
reservation and backoff (transient), **Rejected** = deactivate the workload
(Permanent), a check that is not Active makes the QUEUE Inactive — surfaced,
never a wedge. Fleet's pre-launch gates (buckle-front probe, route audit
verdict, grinder breaker, cred scope, repro gate) each invent their own
retry/terminal behavior. Adoption: classify every launch refusal as
Transient (→ backoff, requeue) or Permanent (→ FAILED + NEED_DECISION) at
one seam; unknown probe verdicts are an INPUT to a bounded re-probe with
requeueAfter — never a slot-holding STATE (that is the W417.4 disease).
Lane liveness fits this pattern precisely on the recovery side: dead lane =
Retry semantics (release claim → READY, backoff), host permanently gone =
Rejected, liveness probe down = surface (event/decision), never wedge.

### 6. Drain semantics (StopPolicy)

Kueue StopPolicy None | Hold | HoldAndDrain on queue suspension. Fleet's
dispatch hold (W1196: named, TTL'd, audited) is exactly Hold; HoldAndDrain
(steer live lanes to wrap up and land a checkpoint) is the missing third
value — useful for maintenance windows. Small surface: a hold flag the
fleet-loop reads to steer (not kill) live lanes. Lowest priority of the six.

## Do NOT adopt

- **K8s reconciliation/CRD machinery, controllers, informers.** Fleet's
  single-writer verbs over governor.db (transactional, CAS'd on claim
  identity) are the right shape for one machine + a few peers. A
  level-triggered reconciler would re-derive the store we already have.
- **FairSharing / multi-tenant quota trees.** One project identity, one
  operator (AGENTS.md: work graph is the ONE ledger). Fairness between
  cohort trees solves a problem fleet does not have.
- **Preemption of RUNNING lanes.** Kueue preempts evictable pods because
  pods are restartable; a lane's in-flight agent context is NOT
  checkpointable (capsules approximate it, deliberately coarsely). Borrowing
  capacity back by killing a working lane burns tokens and evidence —
  the grinder breaker already refuses exactly this.
- **TAS / DRA / MultiKueue.** Topology-aware scheduling, dynamic resource
  assignment, and multi-cluster fan-out are K8s-scale concerns; fleet's
  "topology" is one host + hub profiles.
- **StrictFIFO, partial admission.** Covered in pattern 3 / rejected:
  head-of-line blocking and job-splitting are batch-HPC needs.

## Minted follow-up work items

(minted 2026-10-30, tag `kueue-adoption`)

1. **W2313 — Intent lifecycle state machine** — terminal `FORGOTTEN`
   transition written by the work close/release/reclaim verbs;
   `heldLaunchItems` reads active intents only; sweep the 1,403
   terminal-item rows once at migration.
2. **W2314 — Held/pending/admitted counters** in `work report` + board
   (pattern 2).
3. **W2315 — BestEffortFIFO refill** — item-local deferral with requeueAt
   instead of strict id FIFO (pattern 3).
4. **W2316 — Budget exhaustion → FAILED on the graph** (feeds
   `work retry`), retiring the quarantined-READY parking class (pattern 4).
5. **W2317 — Launch-refusal Transient/Permanent classification** at one
   seam + bounded re-probe with requeueAfter for unknown liveness
   (pattern 5).
6. **W2318 — HoldAndDrain** hold mode (pattern 6) — lowest priority.

## Sources

- https://kueue.sigs.k8s.io/docs/concepts/ — workload lifecycle, admission,
  quota, preemption, admission-check
- kubernetes-sigs/kueue: `apis/kueue/v1beta2/workload_types.go`
  (requeueState, AdmissionCheck states), `clusterqueue_types.go`
  (nominalQuota/borrowingLimit, QueueingStrategy, StopPolicy),
  `pkg/scheduler/scheduler.go` (heads → snapshot → nominate → preempt →
  admit cycle)
- Fleet ground truth: `packages/suspenders/scripts/lib/launch-fencing.ts`
  (intent states, inspectLaunchIntent), `scripts/lib/launch-backoff.ts`
  (backoff ladder), `scripts/dispatch-next.ts:379-540` (capacity math),
  `scripts/lib/refill-window.ts` (target shaping),
  `hooks/lib/work/work-retry.ts` (FAILED recovery),
  `hooks/lib/lanes/dispatch-hold.ts` (Hold semantics).
