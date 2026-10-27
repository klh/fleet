# W1075 — Jepsen: Orkes Conductor 5.3.2 — source dive + fleet applicability

Lane autow1075-p98b319584008df14 · 2026-10-22 · item W1075
(`#task=W1075` on the fleet board).

## Sources and their limits

- Analysis: <https://jepsen.io/analyses/orkes-conductor-5.3.2> (fetched
  2026-10-22; local strip at `.research-w1075/jepsen.txt`, RFC1918
  example lines `scrub:allow`-marked).
- HN: the mission named item **50167583** — that is an unrelated Respan
  gateway launch. The actual discussion is
  [50165904](https://news.ycombinator.com/item?id=50165904) (2026-10-20,
  59 pts, 4 nodes), captured at `.research-w1075/hn-jepsen.txt`.
- Source: Conductor OSS cloned at `research-w1075/conductor`
  (untracked), pinned `5200e86cf78d6fb11d31af50702730932be8d625`
  (OSS main, 2026-10-22). **Orkes Conductor 5.3.2 itself is
  proprietary** — Jepsen tested the commercial product; the receipts
  below cite the public OSS tree, which shares the core mechanisms
  (Orkes engineers maintain it) and already carries several of the
  post-incident hardening patches. Where OSS diverges from the 5.3.2
  behavior Jepsen describes, that is stated per finding.

## The nine findings, verified against source

Jepsen's summary table: #1 → fixed 5.5.6, #2 → "as designed",
#3/#6 → unresolved, #4/#8/#9 → fixed 5.5.6, #5/#7 → fixed 5.5.0.

### #1 — Tasks execute concurrently (fixed 5.5.6)

Jepsen: healthy clusters duplicated short tasks on two workers every
few minutes–hours; a time-of-check-to-time-of-use bug in the sweeper
re-enqueues stuck tasks: sweeper reads task `SCHEDULED`, worker
completes it (DB → IN_PROGRESS/terminal, queue message removed), sweeper
then finds no queue message and re-enqueues → duplicate delivery.

Receipts (OSS main):
- `core/src/main/java/com/netflix/conductor/core/reconciliation/WorkflowRepairService.java:143-170`
  — `verifyAndRepairTask`: `isTaskRepairable` (SCHEDULED/IN_PROGRESS)
  → `containsMessage` → `push`. This is the TOCTOU site exactly as
  Jepsen describes: DB state read, queue checked, queue push — three
  non-atomic steps across two stores.
- `core/src/main/java/org/conductoross/conductor/core/execution/WorkflowSweeper.java:216-239`
  — the active sweeper's repair pass still uses
  `containsMessage → push`, but adds a **second `containsMessage`
  re-check immediately before the push** ("Another repair path can
  restore the message between detection and repush; avoid duplicating
  it") — the direct post-#1 mitigation.
- Lease-style locks cannot prevent this:
  `core/src/main/java/com/netflix/conductor/service/ExecutionLockService.java:52-76`
  — `acquireLock` is optional (`isWorkflowExecutionLockEnabled`),
  lease-based (`lockLeaseTime`, default 60 s,
  `ConductorProperties.java:80`), and carries **no fencing token**:
  a holder past lease expiry is not stopped, only a loser of the
  initial CAS is. Jepsen: locks reduce frequency, cannot prevent.
- The decider holds its lock for whole decide loops:
  `WorkflowExecutorOps.java:1346` computes `maxRuntime =
  lockLeaseTime - 100ms` and at lease exhaustion persists + re-queues
  (:1395-1404) — upstream acknowledged the lease-vs-work race by
  bounding the loop under it.

### #2 — Tasks stall before execution (as designed)

Jepsen: any pause/crash/partition isolating a server from the queue
stalled a handful of workflows for the task's full
`responseTimeoutSeconds` (default 3600) — task shown IN_PROGRESS on a
worker whose `execute()` never ran, recovered only when the response
timeout fired.

Receipts: the stall is structural — the task queue entry is
**postponed** while assigned: the active sweeper's `unack`-equivalent
and `decide` postpone the decider-queue entry out to the running
task's response timeout
(`WorkflowExecutorOps.java:1411-1441`, `computePostpone`;
`core/.../reconciliation/WorkflowSweeper.java:139-205` legacy `unack`
picks min(responseTimeoutSeconds+1, maxPostponeSeconds)). A lost
assignment (message consumed, worker died before execute) is invisible
until that postponed entry resurfaces. No queue-level ack-loss
detector exists; recovery latency = the timeout value itself.

### #3 — Null workflow IDs (unresolved)

Java client `startWorkflow()` rarely returned `null` after Redis crash;
root cause unknown; client 6.0.2 mitigates. Server-side identity comes
from `WorkflowExecutorOps.startWorkflow` → `idGenerator.generate()`
(:2730-2731). Not reproducible in OSS receipts this dive; treat as
client-side.

### #4 — `INSERT INTO null` syntax error (fixed 5.5.6)

Partition manager published a temporarily empty shard→table map;
writes looked up the map and built `INSERT INTO null ...`.
**Orkes-proprietary surface** — OSS postgres-persistence has no
sharding (`PostgresQueueDAO.java:308`: "sharding not implemented").
Fleet-analog: any write path consulting an in-memory registry/map that
can be observed mid-rebuild.

### #5 — Abandoned workflows (fixed 5.5.0)

Jepsen: DB write succeeded, decider-queue enqueue failed → workflow
RUNNING forever, both queues empty; the sweeper "relies purely on the
decider state queue, not the database", so nothing ever finds it.

Receipts:
- `core/src/main/java/com/netflix/conductor/core/dal/ExecutionDAOFacade.java:270-285`
  — `createWorkflow`: `executionDAO.createWorkflow(w)` then
  `queueDAO.push(DECIDER_QUEUE, ...)` — two stores, no shared
  transaction (impossible across DB+Redis), push failure → DB row
  without queue entry.
- `core/.../org/conductoross/conductor/core/execution/WorkflowSweeper.java:122-154`
  — `pollAndSweep` pops **only** `DECIDER_QUEUE` — the queue-only
  reliance Jepsen named. A workflow that never entered the queue is
  unreachable by every sweep pass.
- Post-5.5.0 mitigations visible in OSS: `forceSetLastTaskAsNotExecuted`
  (`WorkflowSweeper.java:330-351`, "database failures where the task
  scheduling failed after the last task was completed") and parent
  re-enqueue `ensureWorkflowExistsInDecider` (:353-359) — but both
  still run **inside** sweep, i.e. only for workflows already in the
  queue. The never-enqueued orphan still needs an out-of-band scan
  (Orkes added one in 5.5.0; not located in OSS main this dive).
- Legacy sweeper residual:
  `com/netflix/conductor/core/reconciliation/WorkflowSweeper.java:107-111`
  — `catch (NotFoundException) → queueDAO.remove(DECIDER_QUEUE)`:
  one transient DB read failure permanently dequeues the workflow —
  the same loss vector from the read side.

 NotFoundException → queueDAO.remove() **converts a read blip into a
 permanent dequeue** — a state machine that punishes transient
 read failures with permanent loss is the sharpest lesson in the whole
 analysis for any claim/lease ledger.

### #6 — Aborted reads (unresolved)

Client retried a timed-out `startWorkflow`, retry failed to connect,
client surfaced only the retry's definite-looking "failed to connect"
— while the first attempt succeeded (1,752/25,920 failed calls actually
created workflows). Server-side counterpart now in OSS:
`startWorkflowIdempotent`
(`WorkflowExecutorOps.java:2761-2813`, ownership-validated get-or-create
under lock) exists precisely to make re-submission safe; the client-side
retry-of-non-idempotent bug itself is client and unresolved.

### #7 — Lost workflows (fixed 5.5.0)

Jepsen: server committed the workflow, the
decider enqueue failed, so the server **deleted the committed record**
("undo"); clients that saw the workflow in the 74s window then got 404
forever.

Receipts:
- `WorkflowExecutorOps.startWorkflow`
  (`WorkflowExecutorOps.java:2728-2757`): catch-all →
  `executionDAOFacade.removeWorkflow(workflowId, false)` — the
  compensating delete is **still live in OSS main**; the code comment
  (2748-2750) acknowledges remove can fail too. `startWorkflowIdempotent`
  repeats it (:2802-2805, gated by `createAttempted`).
- `PostgresExecutionDAO.removeWorkflow`
  (`postgres-persistence/.../PostgresExecutionDAO.java:337-356`):
  tx over mappings + row delete, then per-task deletes **outside** the
  tx — partial-removal residue possible; on the happy path the
  compensating delete turns "enqueue failed" into "everything gone",
  which is #7.

### #8 — Duplicate-key errors on start (fixed 5.5.5 → 5.5.6)

Jepsen: rc1's new insert-retry conflicted with its own earlier write;
the constraint error was relayed to the client. OSS-side mitigation
shape: `PostgresExecutionDAO.createTasks:143-179` dedups via
`addScheduledTask` taskKey inside one transaction (trace line
"Task already scheduled, skipping the run", :156-167) — same-store
retries must be idempotent-by-key, not retry-then-conflict.

### #9 — COMPLETED, never executed (fixed 5.5.6)

Jepsen: retry path makes two writes in different layers — insert the
retry task row, mark the original superseded. Postgres failed between
them; the failure was ignored; original marked superseded with no
successor → sweeper later saw all-terminal tasks → workflow COMPLETED
with `executed: false`.

Receipts:
- `WorkflowExecutorOps.taskToBeRescheduled`
  (`WorkflowExecutorOps.java:578-630`): retry builds the successor copy
  and marks the original `setRetried(true)` + `setExecuted(true)`
  (:624-628) — the supersede/insert pair.
- Retry orchestration `WorkflowExecutorOps.java:509-544`:
  `updateWorkflow` → map `taskToBeRescheduled` → `updateTasks` →
  `scheduleTask` (queue pushes) — three layers, no shared transaction.
- Where the fix shape lives:
  `PostgresExecutionDAO.createTasks:143-179` is transactional
  (`withTransaction`) — the store layer already knows how to make the
  pair atomic; the cross-layer split is the exposure, not the store.

## Cross-cutting theme

Two stores, one logical fact. Every serious finding (#1, #5, #7, #9) is
a DB-row/queue-entry disagreement: who is supposed to run this? The
sweeper trusts the queue as liveness truth; the DB as state truth; the
two disagree under faults, and every "fix" that trusted one store alone
created either duplicates (#1) or loss (#5/#7). Orkes' own fixes
converge on: idempotent-by-key writes, compensating actions that
preserve the record, and out-of-band reconciliation — never delete on a
transient failure.

## Mapping to our stack

Our stack analogs: governor.db work graph (claims/leases/reclaim),
coord WS plane, dispatch launch-backoff, buckle cooldowns.

| Conductor failure mode | Our analog | Could it bite us? |
| --- | --- | --- |
| #1 duplicate exec via TOCTOU re-enqueue | two lanes executing one item | claim exclusivity is enforced at take (owner_sid + W643 claim token) and **fenced at close** (done-gate verifies token + sha ancestry — cf. lane lessons: stale token refuses close, sha ancestor check). The fence exists; exposure is the window between take and done where the lane dies: reclaim → READY → second lane executes. That is by-design at-least-once, but nothing marks the item "possibly double-executed". Low-med. |
| #2 stall until external timeout | buckle cooldown floors / lane watchdog TTL | observed in our own incident history: `retry-after-uncapped-floor` (buckle slept provider quota walls for weeks) is structurally identical — recovery latency = an external timeout value, unbounded. Medium. |
| #3/#6 identity/aborted-read | coord WS redelivery + inbox acks | WS reconnect replay vs live churn (`ws-feed-ids-not-event-ids` lesson: feed ids are not event ids) — delivery dedup is handler responsibility. Our ack contract (`coord ack` per event) is the idempotency seam; handlers that act on events twice are the #6-shaped hazard (act-once semantics not enforced by transport). Medium. |
| #4 empty-map at write time | any in-memory registry consulted at write | not currently identified in our stack; generic watch item. Low. |
| #5 abandoned: DB row, no queue entry | CLAIMED item, wake event lost | a claim whose owner session dies is reclaimed by `work reclaim`/fleet-loop; the residue is the inverse: **lane alive, wake/spawn event lost** → item CLAIMED forever, invisible to reclaim (session looks live). Nothing reconciles claims-without-confirmed-wake. Medium-high (this is our sharpest gap). |
| #7 compensating delete | delete-on-failure anywhere | our graph is transition-only by design (READY/CLAIMED/DONE/FAILED, reclaim = transition); `work retry` requeues FAILED. The durable rule: no deletion on transient failure anywhere in the graph. Low (by construction), keep a law-guard test. |
| #9 non-transactional multi-write closure | `work done` banking event + sha + attribution | if the done-path writes (item state, work.done event, W776 attribution, effort bank) are not one SQLite transaction, a mid-write crash yields closed-item-without-attribution (a #9 residue: terminal state, missing successor data). Verify + pin with a failure-injection test. Unknown → proposed item. |
| Storage safety (§4.2) | governor.db durability | single-node SQLite on `/Volumes/Sensitive` — the same single-node-Postgres caveat Jepsen raises; acknowledged backups exist (db-backup heartbeat). Out of scope to harden here; name the assumption. |

#5 residue: the legacy-sweeper lesson applies to `work reclaim`'s
read-failure paths: **reclaim is a state transition to READY, never a
delete** — keep that invariant with a regression test; a "cleanup" that
deletes is a #7 bug waiting for its partition.

Fleet-side evidence is our own incident history, each already a coord
lesson: retry-after-uncapped-floor, ws-feed-ids-not-event-ids,
lane-retry-budget-quarantine (retry conflict surfaced as user-visible
error — #8 shape), shattered-lane-close (fencing held), work-done-capsule-checkpoint
(closure integrity contract).

## Ranked hardening proposals (not implemented)

1. **done-path transactionality pin** — audit `work done` writes
   (state + event + attribution) as one governor.db transaction; pin
   with a failure-injection regression test. Exposure: every closure.
2. **claim-wake reconciliation** — fleet-loop maintenance task:
   CLAIMED items whose owner session is live but which have no
   confirmed wake/spawn receipt within N minutes → re-nudge (coord
   message) or surface. Catches the #5-shaped stuck-CLAIMED orphan
   reclaim cannot see. Exposure: medium-high, silent otherwise.
3. **reclaim-never-deletes law guard** — regression test pinning that
   reclaim/retry paths only ever transition state, never DELETE rows
   (#7-class). Cheap, permanent.
4. **buckle cooldown ceiling** — cap `retryDelayS` at a bounded max
   with jitter; external timeout values must never become unbounded
   stall commitments (#2-class). Extends the existing
   retry-after-floor lesson into a hard cap.
5. **WS event idempotency seam** — handler-side dedupe on true event
   ids for state-mutating handlers (#3/#6-class double-act). Depends on
   the feed-id/event-id fix direction; scope after W-numbers land on
   the WS id contract.
