# Harness lift research — what other multi-agent harnesses do better

2026-10-10 · companion to swarm-comms-research.md (W436),
grid-coordination-research.md (W437) and cross-hub-project-identity.md.

> Provenance: authored by the Claude GUI peer auditor (source-level read of
> five harnesses, same day), relayed by the owner, landed and fleet-side
> verified by the fleet coordinator (session 1594deac) at suspenders HEAD
> 8ae2e0a. Verified at landing: the identity-doc citations (lane-id
> collision W1.23/W12.3 at line 48, executor_id line 82, attempt_id
> fencing line 86), the local-vs-remote heartbeat split (governor.ts hb
> writes through a local handle, no openStore on that path), and the
> blind-write race below — with one correction: `work reclaim all`'s
> WRITE is already CAS-fenced (`releaseWorkClaim`, work-release.ts:29,
> guards owner+state+updated_at), so it cannot reset a DONE item; the
> unguarded direction is `done`/`fail`/`release`'s blind `setState` (a
> zombie done over a replacement lane's claim). The fix is unchanged.

Question: which mechanisms in open-source agent harnesses comparable to
the fleet are verifiably better than ours and liftable — in local mode and
when lanes, model traffic and the control plane run through hubs?
"Verifiably" means the source code shows the mechanism, the fleet code
shows the gap, and the other project documents why it exists (an incident,
a test or a measurement). Ideas without that evidence are listed as skips.

## Sources read (shallow clones, HEAD at time of reading)

| Project                                    | Commit           | Why it is comparable                                                                     |
| ------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| NousResearch/hermes-agent                  | 66605471, 10 Oct | kanban dispatcher: worker + orchestrator agents, host-scoped claims, heartbeats, budgets |
| gastownhall/gascity (Gas Town's successor) | 74b9254, 10 Oct  | controller/reconciler over a work ledger, health patrol, nudge queue                     |
| steveyegge/beads (Gas City's ledger)       | 76d5bf6, 10 Oct  | dependency-graph work ledger with atomic claim and multi-replica federation              |
| badlogic/pi-mono                           | ea448f4, 10 Oct  | pi-durable busy-conversation inbox, paired-arm evals                                     |
| Dicklesworthstone/mcp_agent_mail           | 2f487bd, 8 Oct   | agent inboxes + file reservations + git pre-commit guard                                 |
| steveyegge/gastown                         | 649b832, 23 Jul  | read for orientation only; superseded by Gas City                                        |

Fleet baseline read: packages/suspenders/hooks/bin/work.ts,
hooks/lib/lane-liveness.ts, hooks/gates/governor.ts,
hooks/session-start.ts, hooks/bin/monitor.ts, hooks/bin/store-server.ts,
hooks/lib/govdb.ts (store port), hooks/lib/hub-locate.ts,
hooks/lib/consult-outbox.ts, scripts/dispatch-next.ts,
packages/buckle/src/cooldown.ts, docs/cross-hub-project-identity.md.

## Verdict

Three of the five lifts fix races or false reclaims that exist in the
fleet code today; the other two close gaps W436 already named. The common
thread: the fleet's claim is atomic (`work take` is a CAS), but every
other transition and the reclaim path are check-then-act, and reclaim
trusts a weaker liveness signal than the rest of the fleet does. Hub
operation makes lifts 1 and 2 more urgent, not less: the race window
grows from a local SQLite call to two HTTP round trips, and the liveness
evidence reclaim relies on exists only on the machine that runs the lane.

## Topology the lifts must hold in

| Mode                   | Where lanes run | Model traffic                                                                        | Work graph, events, facts                                                                                                         |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Local                  | this Mac        | local belt/buckle                                                                    | local governor.db                                                                                                                 |
| Hub-routed models      | this Mac        | `.prefer hub=` → resolveHub (NAS, desktop, IKEA); falls back to local belt, surfaced | local governor.db                                                                                                                 |
| Remote control plane   | any executor    | either of the above                                                                  | `GOVERNOR_STORE_URL` → store-server.ts; one curl per statement, 10 s timeout; `transaction()` holds a server-side BEGIN IMMEDIATE |
| Planned (identity doc) | many executors  | many hubs                                                                            | one logical write authority per managed project; attempt_id with lease and fencing; authority epoch                               |

Facts from the code that the lifts below depend on:

- Claims already record where they were granted:
  `take --origin <hostname>:claude` (dispatch-next.ts ~673, stored in
  `work_items.origin`).
- The governor heartbeat and SessionStart write the local DB
  (governor.ts ~108, session-start.ts ~131 call `openGovernorDb()`),
  while `work` and `coord` use `openStore()`. In remote-store mode the
  heartbeat never reaches the store that holds the claim. (The identity
  doc records the same split for bootstrap.)
- Liveness evidence — pid, transcript, worktree cwd — exists only on the
  executor. govdb.ts already says sweeps that read transcripts run only
  on db.local; `work reclaim all` has no such guard.
- Lane host is `os.hostname()` (dispatch-next.ts ~939, compared in
  lane-liveness.ts). beads documents that the macOS hostname "follows the
  network". This Mac reports itself as `macbook-pro-localdomain`, which
  looks network-assigned — a risk to verify, not a demonstrated failure.
  (Coordinator note: the W605 launch-fencing fix landed 2026-10-10 exists
  precisely because this Mac flips `.local`/`.localdomain` — the
  instability is demonstrated.)

## Adopt-now

### 1. Guarded transitions + a claim epoch (fencing token)

Fleet gap (verified in code). `setState()` (work.ts:485) is a blind
`UPDATE work_items SET … WHERE project = ? AND id = ?`. Only `take`
(work.ts:1004) guards with `AND state = 'READY'`. `done` (work.ts:1055)
reads the row, checks state and owner in JS (1064–1069), then writes blind
inside the transaction. Consequence (corrected at verification): the
zombie direction — a `done` that read its guard before a reclaim + re-take
completes blind-writes DONE over the replacement lane's claim. Re-dispatch
reuses the same sid (dispatch-next "RESUME PATH"), so the `--as` owner
check cannot tell a reclaimed-but-alive lane from its replacement: both
are the owner of record. Only a per-claim epoch can.

Precedent.

- beads PROPOSAL-cas-conditional-update.md: a hostile review of a fleet
  built on bd found check-then-act on assignee/status was "the single
  most common bug class"; re-reads "only narrow the window". Fix: one
  `UPDATE … WHERE id=? AND status IN(…) AND assignee=?`, RowsAffected is
  the verdict, mismatch is a loud non-zero exit. The same proposal routes
  coordination writes through verify-after-write for a degraded server.
- Hermes hermes_cli/kanban_db_dispatch.py: every heartbeat and reclaim
  update is fenced on current_run_id / claim_lock (heartbeat_worker,
  _defer_reclaim_for_live_worker); a worker whose run was reclaimed is
  told to exit (adopt_worker_pid).
- Classic form: Kleppmann's fencing token — a lock holder paused past its
  lease must have its late write rejected by a monotonic token.

Lift. `work_items.claim_epoch INTEGER NOT NULL DEFAULT 0`, incremented by
`take`; dispatch passes it to the lane (env + brief). One helper
`transition(id, to, {fromStates, owner, epoch})` replaces `setState` on
the done/fail/release/start/reclaim paths and returns `.changes === 1`;
zero changes is a non-zero exit naming expected vs actual. Test: two
concurrent done/reclaim on one item — exactly one wins.

Through hubs. The guard is one statement, so it runs atomically inside
store-server.ts and returns changes over the existing RPC — no new
transport. Two hub-specific additions:

- A curl timeout leaves the outcome unknown (the write may have
  committed). An epoch-guarded write is safe to retry; on timeout,
  re-read and accept "already in the target state at my epoch" as success
  (beads' verify-after-write).
- This is the local instalment of the identity doc's attempt_id with
  lease and fencing. When authority failover lands, carry an authority
  epoch too, so writes accepted by an old hub after promotion are
  rejected. Gas City is not a model here: its store has no CAS and its
  fences are per-host flocks (engdocs/design/session-store-fences.md).

### 2. One liveness verdict, judged where the lane runs

Fleet gap (verified in code). `work reclaim all` (work.ts:1320) decides
death from transcript mtime alone (`liveTranscript` → `transcriptPath`,
work.ts:748, 15-minute floor). It ignores three stronger signals the
fleet already has: the governor heartbeat (sessions.hb, W9); the
lane-liveness surface (`laneAlive`, "three consumers, one truth" —
reclaim is not one of them); the monitor's doctrine "lookup failure is
never death" (W51). A glob error returns null, which reclaim reads as
dead. A lane inside one tool call longer than 15 minutes is reclaimable
while alive. In remote-store mode it is worse: run on one machine,
`reclaim all` sees every other machine's lane as dead, because their
transcripts are not local — and their heartbeats went to their own local
DB.

Precedent.

- Gas City cmd/gc/detached_probe.go: tri-state probe — alive holds, dead
  releases, probe error releases only after detachedProbeErrorThreshold =
  3 consecutive errors. execution_backstop.go records the lesson as
  "never nudge on 'we cannot tell'" (#312).
- Hermes tools/kanban_tools.py (#31752): agent activity is bridged to
  last_heartbeat_at on the shared board, rate-limited to one write per
  60 s; an explicit heartbeat lets a worker pre-extend its claim across a
  known-long operation. Pid-based crash reaping only touches claims whose
  lock carries this host's prefix (_reclaim_dead_workers, _host_prefix);
  other hosts' claims expire only through heartbeat age. A reclaimed
  worker that survives termination gets 120 s more rather than a
  duplicate beside it.
- beads docs/multi-agent/federation.md: "Reclaim belongs to the granting
  replica" — each lease records who granted it and reclaim skips foreign
  ones; reclaim grace defaults to 2× lease TTL and must exceed the sync
  interval; replica identity names the store, not the host, with
  deliberately no hostname fallback.

Lift.

- Local evidence (pid, worktree, transcript) may only reclaim claims
  whose origin is this executor. Claims granted elsewhere expire only by
  heartbeat age, with grace ≥ 2× the heartbeat interval.
- Write the heartbeat to the store that holds the claim: route the
  governor hb through `openStore()`, rate-limited to one write per 60 s
  (each remote write is a curl spawn).
- Probe is tri-state; unknown never releases; dead must repeat on N
  consecutive passes (N=3).
- Add `work extend <id> --for 45m --note "<why>"` for known-long ops.
- Replace `hostname()` in origin and lane host with a stable executor_id
  (the identity doc already defines one).

Touch points: hooks/bin/work.ts (reclaim), hooks/lib/lane-liveness.ts
(tri-state, executor id), hooks/gates/governor.ts (heartbeat binding),
scripts/dispatch-next.ts (origin). Satisfies the identity doc's
acceptance test "dead host versus repeated PID on another host" and its
rule "never mark work done or reclaim a claim solely from traffic
inactivity".

### 3. Failure accounting that separates infrastructure from the work

Fleet gap. W437's adopt-now poison-item quarantine and W436's structured
`work fail --cause` have not landed (no fail_count, no `--cause` in the
code). Without them, an item that kills lanes loops dispatch → death →
reclaim → READY.

Precedent (shipped, not proposed).

- Hermes kanban_db_dispatch.py: per-task consecutive_failures
  (DEFAULT_FAILURE_LIMIT = 2, per-task max_retries overrides);
  infrastructure failures are recorded but not counted; rate_limited runs
  are neutral; "clean exit without a terminal call" gets its own streak
  budget (_PROTOCOL_VIOLATION_FAILURE_LIMIT = 3) because, per the code
  comment, ~96% of such tasks complete on a later run (maintainer
  telemetry, not independently verifiable). The retry worker receives the
  prior attempt's error plus up to 400 chars of its final output. Errors
  are fingerprinted (pids/timestamps stripped) so same-root-cause
  failures group.
- Gas City: crash-loop quarantine, max_restarts default 5 per
  restart_window default 1h (internal/config/config.go); review quorum
  separates failure class (none / transient / hard) from verdict
  (internal/reviewquorum/types.go).
- Grid precedent already in W437: Dask's three-worker-death KilledWorker,
  BOINC max_error_results.

Lift. Build W437 item A with Hermes' classification: a fruitless claim
increments fail_count only when the exit was not infrastructure and not a
quota wall (the quota sweep already knows); "lane exited, commits exist,
no work done" is a protocol violation with its own budget of 3 and a
retry brief that says "verify the prior run's commits and close"; inject
the previous attempt's last error into RESUME CONTEXT. Add `--cause`
(W436 item 3) plus a transient|hard infra flag.

Through hubs. Count against the executor class (executor × model —
BOINC's CV(H,V), W437 item B), never against the item, when the cause is
the route: resolveHub unreachable and the lane fell back to local belt, a
hub's 429, or a store-server timeout. Without that split, one flaky hub
quarantines healthy work.

### 4. Deliver directed messages into a running lane (steer vs follow-up)

Fleet gap. toto-gpt.md already flags it: "a WS subscription is not proof
that a new question reaches the model's active context." Directed events
are read at SessionStart and then only when the lane runs `coord inbox`
itself — the brief asks for it twice. Nothing delivers mid-work. The
PostToolUse gate (gates/files.ts) only formats, and the dialect libraries
already emit additionalContext for claude, codex, copilot and grok.

Precedent.

- pi-mono packages/durable ("Busy Conversations"): input to a busy agent
  is queued with an explicit placement — a steer lands after the current
  tool round, a follow-up after the run answers, reject refuses; queued
  items survive a failed run.
- Gas City internal/nudgequeue: persisted pending / in-flight / dead
  queues with attempts, lease, deliver_after and expiry; bounded observe
  → nudge → back off → give up.

Lift. In the PostToolUse gate: if events with target = \<sid\> sit past
the lane's cursor, inject them as additionalContext (steer) and advance
the cursor (the bus already advances only past SHOWN). Consults get a
deadline; undelivered past it moves to dead and emits consult.expired
(W436 item 4).

Through hubs. The gate runs on every tool call, so it must not make a
remote round trip each time: read the local store, or rate-limit remote
reads (one per 30–60 s) and let `coord subscribe` spool pushes to a local
file the gate reads. Messages that cross stores should reuse the pattern
the fleet already has for consults — consult_outbox (enqueued in the same
local transaction, retried with backoff) and consult_relay_receipts
(idempotent by delivery_id) — extended to directed NOTEs.

### 5. Paired-arm evals before changing briefs or protocols

Precedent. pi-mono packages/evals: each case runs in isolated
without_docs and with_docs containers, with repetitions; the report pairs
arms and computes lift. arXiv 2609.05933 (Sept 2026) warns that
multi-agent efficiency gains are often setup-dependent and overestimated
— paired arms on our own tasks are the defence.

Lift. Reuse the runner shape in blam for the comparisons toto-gpt.md
already proposes: condense on/off, consult contract on/off, steer
delivery on/off (lift 4). No new infrastructure: blam scenarios × two
arms × repetitions.

Through hubs. Run each arm per route (local belt vs hub), since hops
change latency and failure mix. First fix the attribution gap the
identity doc records: dispatch-next skips the buckle /w/\<sid\>
attribution when a hub redirect wins, so hub-routed arms are currently
not attributable per lane.

## Adopt-later (trigger-conditioned)

- Hash IDs (beads engdocs/COLLISION_MATH.md: birthday-bound adaptive
  length, nonce retry). beads needs them because every replica writes.
  The identity doc instead plans one write authority per project, where
  IDs minted at the authority can stay sequential. Trigger: items must be
  minted while disconnected from the authority. Independent of that, fix
  the lane-id collision the identity doc found (`W1.23` and `W12.3` both
  become `autow123`; `W1` in two projects shares a sid) before lift 1
  relies on sid + epoch.
- Config-drift restart (Gas City health patrol: SHA-256 of command + env
  per session; drifted sessions drained and restarted). Trigger: lanes
  observed running a stale install after a `version:` bump — more likely
  once hubs pull the pinned ref independently.
- Reliability report by model / prompt version (Gas City
  internal/reliability, read-only over existing events, issue #1254).
  Confirms W437 item B's design — derive the executor trust tally from
  events, add no new emission.

## Skip (fleet already equal or better)

- Claim-before-spawn. dispatch-next runs the CAS `work take` before
  spawning — same guarantee as Gas City's
  tracking-bead-before-dispatch.
- Cross-store delivery. consult_outbox + receipts is already a
  transactional outbox with idempotent receive; nothing in the five
  projects is stronger (Gas City's external stores apply batches
  non-atomically).
- Gateway retry and cooldown. buckle/src/cooldown.ts already ports
  LiteLLM's retry-after-aware backoff and outlier ejection; Hermes'
  credential-pool cooldowns add nothing.
- File reservations and pre-commit guard (Agent Mail). Built for agents
  sharing one working tree; fleet lanes use per-item worktrees plus
  governor locks, and the identity doc keeps file locks executor-local by
  design.
- PID fingerprinting (Hermes: boot epoch + process start time). Fleet's
  sid-in-args check (HARNESS_ARG_RE) already defeats recycled pids
  locally, and lift 2 stops pids from being judged off-executor at all.
- LLM goal-judge completion gate (Hermes). Fails open by design; fleet
  completion is gated on a sha, qlty, tests and paired verify. Who&When
  (W436) puts LLM attribution at 53.5% agent-level.
- Repetition-loop guard (Hermes). Lives inside the model loop; the fleet
  runs third-party harnesses that own their loop.
- "No capability flags, no skills" (Gas City charter). A design
  philosophy, not evidence; conflicts with enforced
  `requires ⊆ capabilities`.

## Volunteer and grid computing — what is still open

W437 already mined BOINC, SETI@home, Folding@home, Sheep-it, Dask and
Ray. Its two adopt-now items are still unbuilt, and the harness code
above now independently confirms both: Gas City ships crash-loop
quarantine and a read-only reliability report; Hermes ships failure
budgets with an infrastructure carve-out. Build them as lift 3.

Read for hub mode, the grid precedent supports lift 2's split directly.
BOINC is hub-and-spoke: the project server is the only authority, clients
never reclaim each other's work, and the server reissues a unit when its
delay_bound deadline passes. Folding@home uses two thresholds — a timeout
that reassigns and a later deadline after which the result earns nothing
— the same shape as beads' lease TTL plus a longer reclaim grace.
Executors judge their own lanes; the authority only times out leases.

One distributed-systems nugget W437 did not cover: fencing tokens
(lift 1). BOINC never needed them because results are validated after the
fact; the fleet does, because a stale lane can mutate the ledger directly
— and through a hub it can do so seconds after its claim was reissued.

## Sources

- Fleet: docs/cross-hub-project-identity.md,
  docs/grid-coordination-research.md, docs/swarm-comms-research.md,
  toto-gpt.md; code paths listed above.
- beads: PROPOSAL-cas-conditional-update.md,
  engdocs/COLLISION_MATH.md, docs/multi-agent/coordination.md,
  docs/multi-agent/federation.md — github.com/steveyegge/beads
- Gas City: engdocs/architecture/health-patrol.md (verified against code
  2026-05-29), engdocs/design/session-store-fences.md,
  cmd/gc/detached_probe.go, cmd/gc/execution_backstop.go,
  internal/nudgequeue/state.go, internal/reviewquorum/types.go,
  internal/reliability/reliability.go, internal/config/config.go —
  github.com/gastownhall/gascity
- Hermes: hermes_cli/kanban_db_dispatch.py, hermes_cli/kanban_db.py,
  tools/kanban_tools.py — github.com/NousResearch/hermes-agent
- pi-mono: packages/durable/README.md, packages/evals/README.md —
  github.com/badlogic/pi-mono
- MCP Agent Mail: src/mcp_agent_mail/guard.py —
  github.com/Dicklesworthstone/mcp_agent_mail
- M. Kleppmann, "How to do distributed locking" (2016):
  martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking
- arXiv 2609.05933, "Rethinking the Evaluation of Efficiency Methods for
  Multi-Agent Systems": arxiv.org/abs/2609.05933
