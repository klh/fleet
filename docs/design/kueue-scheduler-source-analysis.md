# W2320 — Kueue scheduler source analysis: how admission works, mapped to fleet seams

Source pin: `kubernetes-sigs/kueue` @ `1a412c0935107f5bdd0d612734c070f0dd3abf7f`
(shallow clone of main, 2026-10-30, `/tmp/kueue-src-2321/kueue`). Companion:
[w2312-kueue-adoption.md](w2312-kueue-adoption.md) is the WHAT; this note is the
HOW, read from source with file+line for every claim. Program contract:
`coord fact get lesson.kueue-program-contract` — ONE vocabulary home (the W2313
lifecycle module), consumers extract shared logic, never duplicate.

In-flight cross-read at writing time (2026-10-30): W2313 ✓ (f6732063),
W2314 ✓ (0ceca44a, merged), W2315 ✓ (9d6b7635, merged), W2316 ✓ (d2f3fbda),
W2317 ✓ (07348044), W2318 open. Fleet line refs are this tree @ `6e84d3f8`
unless a branch is named.

## 1. One scheduling cycle (`pkg/scheduler/scheduler.go`)

`schedule()` (scheduler.go:334) is a single-threaded loop; every phase is a
function with one job. Six steps:

1. **Heads** (scheduler.go:346 → `Manager.Heads`, manager.go:979). Pops the
   head of every active ClusterQueue heap, blocking while queues are empty
   (cond.Wait). Popping takes an **inflight claim**: the LocalQueue copy is
   dropped and the workload is "checked out" (`takePopped`, manager.go:1021).
   Invariant I2: a checkout ends in exactly one of **admit / requeue /
   forget** — `dropIfAlreadyAccounted` (scheduler.go:822) is the only exit
   that neither requeues nor deletes, and it must forget the claim itself.
2. **Snapshot** (scheduler.go:360, `cache.Snapshot`). A consistent point-in-time
   copy of all ClusterQueue/cohort usage; a failed snapshot requeues every
   popped head and slows the loop (`requeueHeadsAfterSnapshotError`,
   scheduler.go:363,424). Invariant I3: within a cycle, admission of entry N books
   its usage into the shared snapshot (`bookUsage`, scheduler.go:772) so entry
   N+1 sees it — no oversubscription from parallel nominations.
3. **Nominate** (scheduler.go:371 → `nominate` scheduler.go:800,
   `nominateWorkload` scheduler.go:835). Per head: refuse early on failed
   checks, inactive/misconfigured queues, or failed admissibility — each
   refusal stamps a machine-readable `quotaReservedReason`
   (workload_types.go:943-1000) — else compute the full flavor assignment +
   preemption targets via `getAssignments` (scheduler.go:1564).
4. **Order entries** (`makeClassicalIterator`, scheduler.go:1201):
   quota-reserved (second-pass) workloads first, then request-under-nominal
   before borrowing, then higher priority, then FIFO by queue-order timestamp.
   Fair sharing swaps in a tournament iterator instead
   (`makeIterator`, scheduler.go:1171).
5. **Admit/defer** (`processEntry`, scheduler.go:458). Recompute the
   assignment if capacity moved mid-cycle (`updateAssignmentIfNeeded`,
   scheduler.go:885); on `Fit` book usage and call `admit` (scheduler.go:1020)
   — which **assumes the workload in the cache first** (`assumeWorkload`,
   scheduler.go:1141) and patches the API asynchronously, rolling the cache
   back if the write failed (scheduler.go:1051-1073). Invariant I4:
   reservation is effective the instant the cache says so; the write is
   eventual. On `Preempt`: `issuePreemptions` (scheduler.go:663) and the entry
   waits (`RequeueReasonPendingPreemption`); on `DeferredFit` (overlapping
   preemption targets) wait for the victims; `NoFit` requeues with the
   assignment's NoFit reason.
6. **Finish** (`finishEntry` scheduler.go:445, `requeueAndUpdate`
   scheduler.go:1256): assumed/evicted entries are done; everything else is
   requeued with a typed `RequeueReason` and, when never admitted, gets a
   status write carrying the granular `QuotaReservedReason` so the workload
   object explains its own pending state. A cycle that admits nothing
   returns `wait.SlowDown` (scheduler.go:415) — backpressure on the loop
   itself, not on workloads.

Two cycle-shape guards: a fair-sharing **refill pass** may pop successor
workloads mid-cycle once an admission frees capacity
(`newRefillPass`, scheduler.go:385; refill.go:42), bounded by a **global
per-cycle budget** `defaultRefillBudget = 8` (refill.go:36) so one deep queue
cannot stretch the cycle; and `waitForPodsReadyIfNeeded`
(scheduler.go:682) can serialize admission behind previously admitted
workloads actually going ready.

## 2. Queue manager and heaps (`pkg/cache/queue`)

- **Checkout discipline** (I2 on the queue side): `requeueWorkloadLocked`
  (manager.go:779) ends the inflight claim **first, unconditionally**
  (manager.go:786-791), then re-reads the workload fresh from the API
  (manager.go:794, "always get the newest workload to avoid requeuing the
  out-of-date obj"), refuses non-admissible workloads, and only then pushes
  the heap. The claim is never leaked by any path.
- **Requeue vs inadmissible** (`requeueIfNotPresent`, cluster_queue.go:551):
  a workload that could not fit goes to the **inadmissible bucket**, not the
  heap, when the head's backoff has not expired
  (`backoffWaitingTimeExpired`, cluster_queue.go:474 — honors
  `requeueState.requeueAt` to the second); it returns to the heap when its
  backoff expired AND the queue has cycled (`queueInadmissibleCycle >=
popCycle`) or its pending flavors changed. Invariant: backoff is a property
  of the workload record, checked at pop time — the queue never spins on a
  known-unfit head.
- **BestEffortFIFO**: inserting into inadmissible logs "moving the head of
  this ClusterQueue to the consecutive Workload" (cluster_queue.go:594-600) —
  newer fitting work passes a stuck head. The head being preempted is made
  **sticky** so it is re-evaluated first, not buried (preemptorWorkload,
  cluster_queue.go:88-156, Kueue#6929/#7101). With
  SchedulingEquivalenceHashing, one NoFit **bulk-moves every structurally
  equivalent workload** (same scheduling hash) to inadmissible in the same
  cycle (`handleInadmissibleHash`, cluster_queue.go:624).
- **Capacity-freed signaling**: admitting a workload requeues the inadmissible
  workloads of the same ClusterQueue/cohort
  (`QueueAssociatedInadmissibleWorkloadsAfter`, manager.go:927) — the "queue
  went active" edge, not polling.
- **Counts**: `Pending()` (cluster_queue.go:654) splits active vs inadmissible;
  gauges are resynced on every mutation (manager.go:1203). Observable
  saturation is a first-class output, not a derived afterthought.

## 3. API shapes (`apis/kueue/v1beta2`)

- `WorkloadStatus` (workload_types.go:617): max 16 `Conditions`
  (Admitted, QuotaReserved, Finished, PodsReady, Evicted, Requeued,
  DeactivationTarget…, workload_types.go:935-1065), `Admission` (269 —
  immutable once set), `RequeueState` (778: `count` + `requeueAt`, reset on
  reactivate), `AdmissionChecks` (800: per-check state, message,
  `requeueAfterSeconds`, `retryCount`).
- The **reasons are the API**: every QuotaReserved=False write carries one
  enumerated reason (NoMatchingFlavor, WaitingForQuota, Misconfigured,
  Suspended, PendingEvaluation, WaitingForPreemptedWorkloads…). A workload
  row is self-describing; dashboards and recovery policy read reasons, not
  prose. This is what fleet's intent `state` column + W2317 refusal enum
  replicate.
- `ClusterQueueSpec` (clusterqueue_types.go:68): `queueingStrategy`
  (114; StrictFIFO 209 / BestEffortFIFO 214), `stopPolicy` (151;
  None/Hold/HoldAndDrain), per-flavor `nominalQuota` (331) /
  `borrowingLimit` (343) / `lendingLimit`, `cohortName`, `flavorFungibility`
  (when-can-borrow/when-can-preempt × MayStopSearch/TryNextFlavor). Quota is
  a 2-D lattice (flavor×resource) with separate nominal/borrow/lend caps —
  not one scalar target.
- `CheckState` (admissioncheck_types.go:23): Pending / Ready / Retry /
  Rejected — exactly two failure semantics (transient vs permanent).

## 4. AdmissionCheck wiring

- `SyncAdmittedCondition` (admissionchecks.go:39) is the single join point:
  **Admitted = quota reserved ∧ all required checks Ready** (plus topology
  assignments). Reservation alone never flips Admitted — the two-phase
  commit (I1) lives in this one function.
- The scheduler refuses to nominate workloads whose checks include Retry or
  Rejected (scheduler.go:843-846).
- **Retry = transient**: `reconcileCheckBasedEviction`
  (workload_controller.go:1027) evicts on any Retry check
  (releases the reservation, workload_controller.go:1055-1066) —
  `ResetChecksOnEviction` (evict.go:222) puts checks back to Pending for the
  next attempt. The check controller sets `RequeueAfterSeconds` via
  `UpdateAdmissionCheckRequeueState` (admissionchecks.go:230) —
  `60s·2^(n-1)+jitter`, capped — and the reconciler merges the max retry
  time into `requeueState.requeueAt` (`NeedsRequeueAtUpdate`,
  admissionchecks.go:208 → workload_controller.go:548-560). The workload
  then waits out the backoff as `RequeueAfter`
  (workload_controller.go:614-651) and re-enters the queue only when the
  elapsed backoff made it admissible again (`backoffWaitingTimeExpired`).
- **Rejected = permanent**: the same reconcile targets **deactivation**
  (`SetDeactivationTarget`, workload_controller.go:1035-1050) — terminal,
  surfaced, never retried silently. A rejected check also applies mid-eviction.
- Queue stopped ≠ workload dead: StopPolicy Hold marks pending workloads
  `QuotaReserved=False/Suspended` (workload_controller.go:1162-1167);
  HoldAndDrain additionally evicts admitted ones (1148-1160). The gate is on
  the QUEUE (surface), the effect is on the workload — and `statusChecker.
ClusterQueueActive` (manager.go:1006) removes stopped queues from
  head selection entirely, so nothing waits inside a dead queue.

## 5. Eviction and requeueState writes

- `Evict()` (evict.go:143) is the ONE writer for all eviction reasons
  (preempted / PodsReady timeout / admission check / CQ-LQ stopped /
  deactivated, workload_types.go:1040-1049). One status patch does everything
  atomically: `prepareForEviction` (evict.go:206) = SetEvictedCondition +
  reset cluster nomination + ResetChecksOnEviction + reset unhealthy nodes +
  unset/close preemption gates. No path hand-rolls an eviction.
- The backoff counter lives in `requeueState`: `UpdateRequeueState`
  (workload.go:953) increments count and computes requeueAt
  (`60s·2^(n-1)+jitter`, base/max configurable); `SetRequeueState`
  (workload.go:973) is **monotone — it never overwrites a later requeueAt**
  ("the requeue state is shared between multiple components, so we have to
  ensure that we don't overwrite a future requeue").
- **Limit exhaustion is terminal, not eternal**: `triggerDeactivation`
  (workload_controller.go:1343) fires when `count+1 > backoffLimitCount` and
  stamps `DeactivationTarget/RequeuingLimitExceeded`; the deactivation path
  clears `requeueState` (workload_controller.go:723-731). Reactivation resets
  the count (workload_types.go:782-792). Fleet's W2316 (budget exhaustion →
  FAILED through the shared transition writer, fresh budget on `work retry`)
  is this exact shape with fleet's own terminal vocabulary.

## 6. Preemption (for cycle completeness; NOT adopted)

Candidate ordering (policy/ordering.go:36-43): already-marked victims first,
other-ClusterQueue members before the preemptor's own queue, lower effective
priority first, most-recently-admitted first. `IssuePreemptions`
(preemption.go:318) evicts through the same `Evict()` writer, guarded by a
preemption-expectations store so a concurrent observation is never
double-counted. W2312 correctly rejects adopting this (lane context is not
checkpointable); the only transferable idea is the ordering's "others before
own" fairness, which fleet gets structurally from per-item dispatch.

## 7. Mechanism → fleet seam map

| Kueue mechanism (source)                                                                                                         | Invariant it enforces                                                                                                  | Fleet seam                                                                                                                                                               | Status                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Two-phase admission: QuotaReserved → checks → Admitted (`SyncAdmittedCondition`, admissionchecks.go:39)                          | reservation ≠ running; the join is ONE function                                                                        | launch intents PREPARING/REGISTERED (launch-fencing.ts:282,338) vs live-lane verdict (`inspectLaunchIntent`, launch-fencing.ts:208)                                      | adopted: W2313 lifecycle + W2314 counters                                                                          |
| Checkout/inflight claim ends in exactly one of admit/requeue/forget (scheduler.go:822, manager.go:786)                           | no popped workload is ever silently lost                                                                               | intent must reach ADMITTED/FAILED/FORGOTTEN — never linger REGISTERED (`heldLaunchItems` reads state!='FAILED' pre-W2313, launch-fencing.ts:122)                         | adopted: W2313 `forgetLaunchIntent` stamps FORGOTTEN inside the close/release/reclaim tx (branch suspenders/W2313) |
| Snapshot + per-entry `bookUsage` (scheduler.go:360,772)                                                                          | mid-cycle admissions are visible to later entries                                                                      | dispatch cycle re-reads live/held per launch (`canLaunch`, dispatch-next.ts:506-510) — serial cycle inherits the invariant; SQLite tx is the snapshot                    | not needed; documented overlap                                                                                     |
| Assume-in-cache then async API write with rollback (scheduler.go:1141,1051)                                                      | capacity accounting leads the durable write                                                                            | fleet inverts it: `reserveLaunchIntent` (launch-fencing.ts:233) is the durable reservation, the lane's liveness is the eventual fact                                     | deliberate divergence (single-writer store, no cache layer)                                                        |
| Head ordering: reserved-first, nominal-before-borrow, priority, FIFO (scheduler.go:1201)                                         | second passes overtake fresh work                                                                                      | resume candidates processed before the READY FIFO pool (dispatch-next.ts:526-539 vs 560-575)                                                                             | already isomorphic                                                                                                 |
| BestEffortFIFO: stuck head set aside, refill continues (cluster_queue.go:594)                                                    | an unadmittable head never blocks newer fitting work                                                                   | READY-pool deferral with requeueAt (`requeuePending` filter, dispatch-next.ts:572-574; W2315 `.fleet/dispatch-defers.json`)                                              | adopted: W2315                                                                                                     |
| Equivalence-hash bulk inadmissible move (cluster_queue.go:624)                                                                   | structurally identical workloads don't each burn a cycle                                                               | none — refusals are per-item                                                                                                                                             | GAP → W2331                                                                                                        |
| `backoffWaitingTimeExpired` (cluster_queue.go:474): backoff is data on the record, checked at pop                                | the queue never spins on a known-unfit head                                                                            | launch-backoff `eligibleAt` gates refill (`activeRateLimitWalls` pacing, launch-backoff.ts:32; ladder launch-backoff.ts:64-65)                                           | adopted (pre-existing W1025/W1165)                                                                                 |
| `RequeueState {count,requeueAt}`, monotone `SetRequeueState` (workload.go:953,973)                                               | one backoff record; a later wall is never overwritten by an earlier one                                                | fleet has THREE requeue-at writers: backoff facts `eligibleAt` (launch-backoff.ts:194-202, last-write-wins), W2315 defers, W2317 re-probe spec                           | GAP → W2330                                                                                                        |
| Limit exhaustion → DeactivationTarget → terminal, surfaced, count reset on reactivate (workload_controller.go:1343,723)          | bounded retries, then an honest terminal state                                                                         | `parkExhaustedLaunch` → W2316 lands FAILED through the shared transition writer; `work retry` = reactivate (fresh budget)                                                | adopted: W2316                                                                                                     |
| AdmissionCheck Retry/Rejected split + `requeueAfterSeconds` backoff (admissioncheck_types.go:30-44; workload_controller.go:1027) | transient refusals release the slot and back off; permanent refusals deactivate — never a held slot with unknown state | W2317 `LaunchRefusalSchema` Transient/Permanent + bounded 30s/120s/300s re-probe, exhaustion surfaces and RELEASES the slot (branch suspenders/W2317, launch-fencing.ts) | adopted: W2317                                                                                                     |
| StopPolicy Hold/HoldAndDrain; stopped queue leaves head selection (workload_controller.go:1141-1167, manager.go:1006)            | hold is surfaced queue state, drain is explicit                                                                        | dispatch hold = named TTL'd Hold (`setHold`, dispatch-hold.ts:92; consumed dispatch-next.ts:509, refill-window.ts:17); HoldAndDrain (steer, not kill) = W2318, open      | W2318 pending                                                                                                      |
| Per-cycle refill budget 8 (refill.go:36) + fair-sharing mid-cycle refill (scheduler.go:385)                                      | cycle length and freshness bounded regardless of backlog                                                               | plaid cycles are time-capped only (`plaidCycleOpen` 12 min, refill-window.ts:34); no count budget                                                                        | GAP → W2332                                                                                                        |
| Nominal vs borrowingLimit as separate caps (clusterqueue_types.go:331,343)                                                       | reserve ≤ min(usage, nominal+borrow−used) (`quotaResourcesToReserve`, scheduler.go:958)                                | one scalar steady target mixes held+live+dispatched (dispatch-next.ts:510); target shaping shrinks by walls (`refillWindow`, refill-window.ts:37-49)                     | W2312 pattern 2 refinement, not minted (config-over-code later)                                                    |
| Pending active/inadmissible gauges resynced per mutation (cluster_queue.go:654, manager.go:1203)                                 | saturation is observable at all times                                                                                  | W2314 report-capacity pending/held/admitted triple (merged 0ceca44a)                                                                                                     | adopted: W2314                                                                                                     |
| `QuotaReservedReason*` enumerated refusal reasons (workload_types.go:943-1000)                                                   | every pending row explains itself                                                                                      | `LaunchFailure.kind` (launch-backoff.ts:6-11) + W2317 refusal verdicts; terminal FAILED carries reason via W2316 event vocabulary                                        | adopted; see F4 for the terminal-record surface                                                                    |
| Cycle backpressure: `wait.SlowDown` when nothing admitted (scheduler.go:415)                                                     | the loop itself backs off, independent of workload backoff                                                             | grinder breaker + rate-wall pacing pause/refuse launches (dispatch-next.ts:445-472,484-490)                                                                              | adopted (pre-existing)                                                                                             |
| Preemption of running work (preemption.go:318)                                                                                   | rejected — see §6                                                                                                      | grinder breaker refuses exactly this (dispatch-next.ts:445)                                                                                                              | not adopted (W2312)                                                                                                |

## 8. Where the source beats the W2312 sketch — minted follow-ups

- **F1/W2330 — One monotone requeue-merge rule.** Kueue's `SetRequeueState`
  (workload.go:973-992) never moves requeueAt earlier and counts only on
  evidence; fleet now has three requeue-at vocabularies (launch-backoff
  `eligibleAt` last-write-wins at launch-backoff.ts:194-202, W2315 defers,
  W2317 re-probe) that can fight over one item. Land the merge rule in the
  W2313 lifecycle module: later wall wins, earlier never clobbers later,
  count increments only on attempt-scoped evidence.
- **F2/W2331 — Equivalence-shape bulk deferral.** When a refill refusal is
  capability-starved (or requires-blocked), every READY item with the same
  requirement shape will refuse identically — fleet currently discovers this
  once per item. Kueue bulk-moves them by scheduling hash in one cycle
  (cluster_queue.go:624). Defer siblings by shape hash on the W2315 ladder.
- **F3/W2332 — Plaid per-cycle launch budget.** `defaultRefillBudget = 8`
  (refill.go:36) bounds launches per cycle so a deep READY pool cannot turn a
  12-minute window into forty spawns. Fleet's plaid posture is time-capped
  only (refill-window.ts:34). Add a count budget alongside the clock.
- **F4/W2333 — Reason-carrying terminal records.** Every Kueue terminal/pending
  write carries an enumerated reason the API can query. Fleet's FAILED items
  should surface the launch-failure kind (rate-limit/upstream/transport/
  configuration) as a machine-readable field on the terminal record so
  `work retry` policy and the board can be reason-aware, not transcript-diving.

## 9. W2321 note: MultiKueue (out of scope here)

Confirmed from source: the MultiKueue implementation lives under
`pkg/controller/admissionchecks/multikueue/` (plus the workload-side wiring in
`pkg/controller/core/workload_controller.go` `hasMultiKueueAdmissionCheck`,
workload_controller.go:249) — NOT under a top-level `pkg/multikueue`; KEP at
`keps/693-multikueue`. Its core trick is that MultiKueue is literally an
**AdmissionCheck**: reservation happens locally, a remote cluster's ack flips
the check Ready, and the shared check-sync machinery
(`syncAdmissionCheckConditions`, workload_controller.go:1256) does the rest —
the two-phase commit is reused unchanged.

## Sources

- Clone: `kubernetes-sigs/kueue` @ `1a412c0935107f5bdd0d612734c070f0dd3abf7f`
  (2026-10-30), `/tmp/kueue-src-2321/kueue`.
- Core files read: `pkg/scheduler/scheduler.go`, `pkg/scheduler/refill.go`,
  `pkg/scheduler/flavorassigner/{flavorassigner,assignment}.go`,
  `pkg/scheduler/preemption/{preemption.go,policy/ordering.go}`,
  `pkg/cache/queue/{manager,cluster_queue,inadmissible_workloads}.go`,
  `pkg/controller/core/workload_controller.go`,
  `pkg/workload/{workload,admissionchecks}.go`,
  `pkg/workload/evict/evict.go`,
  `apis/kueue/v1beta2/{workload_types,clusterqueue_types,admissioncheck_types}.go`.
- Fleet ground truth: `packages/suspenders/scripts/dispatch-next.ts`,
  `scripts/lib/{launch-fencing,launch-backoff,refill-window}.ts`,
  `hooks/lib/lanes/dispatch-hold.ts`, plus the W2313/W2316/W2317 branch tips.
