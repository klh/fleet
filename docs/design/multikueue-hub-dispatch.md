# MultiKueue → fleet hub dispatch — source analysis and design

Research note (2026-10-30), item W2321. Source: kubernetes-sigs/kueue `main`
(shallow clone; implementation under
`pkg/controller/admissionchecks/multikueue/` — NOT `pkg/multikueue/` — plus
KEPs 693/9270/8303/2349/13243/9988). Companion to W2312
(`docs/design/w2312-kueue-adoption.md`), which rejected MultiKueue as a
"K8s-scale concern"; the owner directive for this item supersedes that: tasks
MAY run directly on hubs (nas/desktop), not only on dev machines. The finding
below is that MultiKueue's **mechanisms** are adoptable without its K8s
machinery — they validate w1124.18.2's design choices and add four things that
plan lacked. Every claim cites file+line from the clone (main @ 2026-10-30).

## 1. Roles and topology

One designated **management cluster** runs `kueue-controller-manager` with the
MultiKueue controllers; every **worker cluster** runs a full Kueue that admits
workloads by REAL local capacity (KEP-693 §Proposal: "some Kueue running there
admits the workload"). The manager holds the workload Pending; workers never
write the manager's state — they influence the manager only through the
objects the manager reads over the remote connection (cloned workloads +
admission/status conditions the manager reads back).

Fleet analog, at the topology level: the dispatch authority (the project's
`dispatch` controller-class lease holder, W1124.18.1/W576.5 controller-fence)
is the manager; a hub (nas/desktop) is a worker. Fleet's twist: the manager
role is **lease-movable**, not fixed — w1124.18.2 R3 already decided the
authority can hand off hub-side. MultiKueue's "management cluster could be a
single point of failure" mitigation list (KEP-693 Risks) is the same trade the
authority-handoff design already carries.

## 2. The admission protocol — reconcileGroup step by step

`pkg/controller/admissionchecks/multikueue/workload.go:510` `reconcileGroup`
is the protocol. Numbered as in source:

1. **Hold.** The manager-side workload keeps quota RESERVED at the manager
   (`HasQuotaReservation` gate, workload.go:531) — capacity is held at the
   center while candidates are probed. Fleet analog: the dispatch target slot
   held by a REGISTERED launch intent (W2313's lifecycle) while the hub
   harness spins up.
2. **Clone to nominated workers.** Clones are created on the nominated
   workers (`nominateAndSynchronizeWorkers`, workload.go:1021); the real job
   is NOT created until one worker admits. Fleet: the placement row (18.2 R2)
   - claim mint together; the lane process is the "clone" that becomes the
     real job.
3. **First admission wins.** The first worker to admit becomes
   `status.clusterName`; the others' clones are deleted
   (workload.go:699-743, `bestMatchByCondition(WorkloadAdmitted)` then the
   removal loop). No lease on the answer is needed — deletion of losers +
   immutability of `clusterName` after admission converge a racy first-admit
   without a leader.
4. race note: two workers can admit "simultaneously"; convergence is
   guaranteed because the manager treats the first AdmissionCheck state it
   reads as final once it sets `clusterName` and deletes loser clones
   (workload.go:733-743). KEP-693's integration test list includes "Job is
   admitted at the same time by two clusters" as a required scenario.
5. **Materialize the job where admitted.** Only after a winner exists does
   `SyncJob` create the real job object on the winner, with
   `SetMultiKueueMeta` (origin label + prebuilt-workload label,
   job_multikueue_adapter.go:107) and `ManagedBy` CLEARED
   (job_multikueue_adapter.go:110) so the local
   controller takes over; the manager's own copy keeps
   `ManagedBy=kueue.x-k8s.io/multikueue` (`IsJobManagedByKueue`,
   job_multikueue_adapter.go:223) so the manager's job controller stands down
   — "no job controllers running in the management cluster" (KEP-693 §Proposal).
   Fleet: the hub harness runs the lane with a per-lane `bksk_` key and
   per-lane settings; the dev-machine never spawns it. The managedBy split is
   exactly the fleet's "who supervises this process" question: the host that
   supervises is the host that runs.
6. **Status copy-back.** While running, the manager copies the remote job
   status onto its own Job object (`determineStatusUpdate`,
   job_multikueue_adapter.go:121), with a monotonic `failed` counter
   (`mergeJobStatus`, job_multikueue_adapter.go:208). Fleet: evidence is
   monotone — a hub-side close can only move an item forward
   (READY→CLAIMED→DONE), never rewrite history.

## 2b. Loss handling — the part worth copying verbatim

- `connectionState` records `disconnectedSince` and PRESERVES it across
  failed reconnect attempts: "the worker-lost grace measures from the first
  loss, not the latest failed retry" (multikueuecluster.go:206-250). The grace
  clock does not reset on each failed probe.
  **Adopt.** Fleet's dead-claim FSM and lost-hub policy (W2321.4) must measure
  grace from first observed loss, not per-probe.
- **workerLostTimeout** default 15 min (apis/config/v1beta2/defaults.go:51);
  an admitting worker unreachable past the grace flips its admission check to
  `Retry` ("Admitting remote lost", workload.go:712-720) — the item requeues
  BUDGETED, not silently. On reconnect, `requeueWorkloadsForCluster`
  (multikueuecluster.go:434) re-queues every workload whose
  `clusterName` or nomination includes the cluster — evidence resync, not
  state rebuild.
- **Orphan GC.** Every remote object the manager creates carries an origin
  label (`MultiKueueOriginLabel`); `runGC` (multikueuecluster.go:762) lists
  remote workloads BY ORIGIN, deletes those whose local counterpart is gone,
  and deletes their owner job too — and it runs only when the client is
  CONNECTED (multikueuecluster.go:765). Deletion authority is conditioned on
  connectivity to the authority's records, and ownership is proven by the
  origin marker, never by absence alone.
  **Adopt** for hub worktrees/serve processes: artifacts carry the
  authority identity (claim epoch/sid), GC deletes only artifacts whose
  claim is terminal at the authority AND that carry OUR origin marker
  (W2321.5) — never "file exists and nothing knows it".
- Connect backoff ladder: `retryAfter` = 5 s × 2^n capped at 7 steps
  (multikueuecluster.go:83-85, :105) and watch-establishment backoff 1→10 min
  (multikueuecluster.go:92-100).

## 3. Nomination (the dispatcher API)

`nominateAndSynchronizeWorkers` (workload.go:1021) clones to workers per the
configured dispatcher: **AllAtOnce** (workload.go:1084), **Incremental**
(3 clusters per 5-min round — KEP-9270), **External** (`nominatedClusterNames`
set by an external controller; both read `nominatedClusterNames`,
workload.go:1104). Fleet has TWO hubs, not 10; **reject AllAtOnce** (it burns
the resource fleet cannot mint — lane tokens on every hub — to save one
waiting round) and adopt the Incremental shape as "place at ONE hub; expand
after a bounded round if unclaimed", which is also what
`work allocate`'s reclaimed-first FIFO already does across LANES on one host —
the hub axis adds a second-level loop, not a new algorithm.

`nominatedClusterNames` is reset when `status.clusterName` is set and is
immutable while admitted — nomination state dies at admission. Fleet analog:
placement rows expire with the claim epoch (18.2 R2), never outlive the claim
(the W2313 FORGOTTEN law applied to placement).

## 4. Quota visibility — KEP-9988

Manager-side ClusterQueue quota is an AGGREGATION of the worker ClusterQueues
(KEP-9988 Summary); workers keep authoritative local limits; the manager quota
is a global cap + visibility surface, not the real limit. Fleet: `work
report`'s capacity row stays the authority (one dispatch target); hub capacity
from SUPPORTS `resources.lane_slots` joins placement as a CONSTRAINT, not a
second quota truth. Reject the aggregation machinery itself — fleet has one
authority, so the aggregation is a board-render, not a reconciler.

## 5. The single-writer question (the mission's explicit ask)

Answer: **replica for reads, never partitioned writes; authority is
lease-movable, not location-partitioned.** This is w1124.18.2 §3 decision A
(one authoritative hub, epoch CAS, non-authoritative parties degrade to
read-only clients) — and MultiKueue confirms it: workers NEVER mutate the
manager's graph; they only present objects the manager reads over the
connection. MultiKueue's "assume total loss of all running workloads on
disconnect" (KEP-693) is the manager-side cost of that shape; fleet's version
is milder because the work graph holds EVIDENCE (claims, shas, capsules), not
running processes — a lost hub means claims lapse through the existing
dead-claim FSM into READY (budgeted), not a state rebuild.

Practical shape, per phase:

- **Mac holds the lease** (phase 1): hub lanes run hub-side but the graph
  mutations (claim, done, events) are accepted only by the authority. The hub
  harness calls through the store face; `work done` executes against the
  authority's store port (:7794) — hub stores :7795/:7796 stay read replicas
  (W362 shape: read-only mirrors, never graph mutation).
- **Hub holds the lease** (phase 2, w1124.18.2 R3 handoff): the hub store
  becomes authoritative for the project; the Mac degrades to client. MultiKueue
  has no analog for MOVING the manager — this is pure 18.2 R3 machinery.

This also answers "replica vs partition": the single-writer constraint is per
PROJECT, not per HOST; a hub is a worker (executor) while it does not hold the
lease, and the manager while it does. There is no fleet-legal configuration in
which two hosts write the same project graph.

## 5b. What transfers to fleet — the adopt list

- **First-loss grace** (connectionState + workerLostTimeout) → W2321.4.
- **Origin-labeled, connectivity-gated orphan GC** → W2321.5.
- **ManagedBy role split** ("the host that supervises is the host that runs"):
  hub lanes are supervised hub-side; the dispatch authority only ACCOUNTS for
  them. Evidence flows back as monotone events (work.done + W776 attribution)
  → W2321.3.
- **Nomination = placement rows with expiry**; Incremental-style
  place-one-expand-later; nomination state never outlives admission →
  W2321.2.
- **Cluster connection validation** (multikueuecluster.go:1033-1093:
  kubeconfig path prefix pinning :824, TLS required, tokenFile banned,
  server URL required): SUPPORTS faces should validate hub faces the same
  fail-closed way — the SUPPORTS `probed` tier rides faces that already exist
  (buckle health sidecars, knowledge sink, store), the `tested` tier is the
  18.2 drill registry.

## 6. Rejected for fleet (the W2312 rejection stands for the machinery)

- CRD/controller/informer machinery and workload-object cloning — fleet's
  single-writer verbs over governor.db are the right shape (W2312 Do-NOT-adopt
  stands).
- AllAtOnce nomination.
- Orchestrated preemption (KEP-8303): preempting a working lane burns
  checkpointable context — W2312 already rejected preemption of RUNNING lanes.
- "Assume total loss on disconnect" as a fleet behavior: K8s pods are
  declarative and re-admittable; a lane's in-flight agent context is not
  checkpointable except as a coarse capsule, so fleet treats a lost hub as
  claim lapse → READY (budgeted requeue), not as loss of the work.

## 7. Prerequisites and minted items

Prerequisite (mission-noted): hub tokens lack `buckle:admin:WRITE_` today, so
the dispatch authority cannot mint per-lane `bksk_` keys hub-side — re-mint is
the prerequisite (minted as **W2321.1**).

Minted under W2321 (tag `kueue-adoption,hubs`):

| Item    | Scope                                                             |
| ------- | ----------------------------------------------------------------- |
| W2321.1 | Hub belt tokens re-minted with `buckle:admin:WRITE_` (prereq)     |
| W2321.2 | Hub-side dispatch face: placement rows → ssh-spawned lane harness |
| W2321.3 | Evidence flow back: shas/spend/attribution on the authority       |
| W2321.4 | Lost-hub requeue policy: first-loss grace + budgeted requeue      |
| W2321.5 | Hub orphan GC: origin-marked artifacts, authority-gated deletion  |

All five slot INTO w1124.18.2's §5 dependency order (1→4 advertise truth,
5→6 place+execute, 7→8 prove end-to-end); none re-derives SUPPORTS, the drill
registry, placement rows, or the authority handoff — those are 18.2's items,
gated behind sustained40 and a reviewed plan. Open decisions ride 18.2 §7
(evidence TTLs, first authoritative hub, drill cost policy, drill cadence) —
one addition: lost-hub grace duration (propose 15 min, MultiKueue's default,
`apis/config/v1beta2/defaults.go:51`).

## 8. Honest disanalogies

- Kueue clones a DECLARATIVE object; fleet dispatches a PROCESS with
  non-checkpointable in-flight context. The admission ACK is "lane live", not
  "quota reserved" — quota accounting stays at the authority (W2314 counters).
- Kueue's manager copies job STATUS back because the manager's API has the
  object; fleet's authority holds the work graph, so "status copy" = events
  (work.done, attribution, capsules) replayed/accepted by the authority —
  monotone forward-only, per §2 step 6.
- Two hubs ≠ ten clusters: nomination algorithms are near-trivial at n=2.
  The durable value is the CONNECTION + LOSS + GC discipline, not the
  dispatcher zoo.
- Kueue workers run the same Kueue binary as the manager; fleet hubs run the
  hub service set (gateway/store/board) — the hub-side lane harness is NEW
  surface (W2321.2), and hub port-publishing can die while containers report
  healthy (coord fact lesson.hub-reboot-needs-compose-up), so the
  hub probe must be the OUTSIDE view — the health-is-outside-process law
  already encodes this; SUPPORTS probes ride the sidecars, not the served
  process.
