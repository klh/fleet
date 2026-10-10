# Harness lift research — what other multi-agent harnesses do better

2026-10-10 · companion to swarm-comms-research.md (W436) and
grid-coordination-research.md (W437).

> Provenance: authored by the Claude GUI peer auditor (source-level read of
> five harnesses, same day), relayed by the owner, landed and fleet-side
> verified by the fleet coordinator (session 1594deac) at suspenders HEAD
> 8ae2e0a. All three race claims were re-checked against the code before
> landing; one consequence-illustration was corrected (see lift 1).

Question: which mechanisms in open-source agent harnesses comparable to the
fleet are verifiably better than ours and liftable? "Verifiably" means the
source code shows the mechanism, the fleet code shows the gap, and the
other project documents why it exists (an incident, a test or a
measurement). Ideas without that evidence are listed as skips.

## Sources read (shallow clones, HEAD at time of reading)

| Project                                    | Commit           | Why it is comparable                                                                 |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| NousResearch/hermes-agent                  | 66605471, 10 Oct | kanban dispatcher: worker + orchestrator agents, claims, heartbeats, failure budgets |
| gastownhall/gascity (Gas Town's successor) | 74b9254, 10 Oct  | controller/reconciler over a work ledger, health patrol, nudge queue                 |
| steveyegge/beads (Gas City's ledger)       | 76d5bf6, 10 Oct  | dependency-graph work ledger with atomic claim — the closest analog to `work`        |
| badlogic/pi-mono                           | ea448f4, 10 Oct  | pi-durable busy-conversation inbox, paired-arm evals                                 |
| Dicklesworthstone/mcp_agent_mail           | 2f487bd, 8 Oct   | agent inboxes + file reservations + git pre-commit guard                             |
| steveyegge/gastown                         | 649b832, 23 Jul  | read for orientation only; superseded by Gas City                                    |

Fleet baseline read: packages/suspenders/hooks/bin/work.ts,
hooks/lib/lane-liveness.ts, hooks/gates/governor.ts, hooks/bin/monitor.ts,
scripts/dispatch-next.ts, hooks/lib/govdb.ts, packages/buckle/src/cooldown.ts.

## Verdict

Three of the five lifts fix races or false reclaims that exist in the fleet
code today; the other two close gaps W436 already named. The common
thread: the fleet's claim is atomic (`work take` is a CAS), but the other
transitions write blind, and reclaim trusts a weaker liveness signal than
the rest of the fleet does.

## Adopt-now

### 1. Guarded transitions + a claim epoch (fencing token)

Fleet gap (verified in code). `setState()` (work.ts:485) is a blind
`UPDATE work_items SET … WHERE project = ? AND id = ?`. Only `take`
(work.ts:1004) guards with `AND state = 'READY'`. `done` (work.ts:1055)
reads the row, checks state and owner in JS (1064–1069), then writes blind
inside the transaction — the guard is stale by write time.

Consequence (corrected at verification): `work reclaim all`'s WRITE is
already CAS-fenced — `releaseWorkClaim` (work-release.ts:29) guards
`owner_sid IS ? AND state = ? AND updated_at = ?`, so a reclaim can never
clobber a completed item, and a concurrent `done` makes the reclaim skip
("claim changed"). The unguarded direction is the mirror image: a zombie
`done` that read its guard before a reclaim + re-take completes will
blind-write DONE over the replacement lane's claim (and release the stale
owner's claim record). Same fix either way:

- `work_items.claim_epoch INTEGER NOT NULL DEFAULT 0`, incremented by
  `take`; dispatch passes it to the lane (env + brief). One helper
  `transition(id, to, {fromStates, owner, epoch})` replaces `setState` on
  the done/fail/release/start paths and returns `.changes === 1`; zero
  changes is a non-zero exit naming expected vs actual.
- Re-dispatch reuses the lane sid family (dispatch-next "RESUME PATH"), so
  the `--as` owner check cannot tell a reclaimed-but-alive lane from its
  replacement: only a per-claim epoch can.

Precedent.

- beads PROPOSAL-cas-conditional-update.md: a hostile review of a fleet
  built on bd found check-then-act on assignee/status was "the single most
  common bug class"; re-reads "only narrow the window". Fix: one
  `UPDATE … WHERE id=? AND status IN(…) AND assignee=?`, RowsAffected is
  the verdict, mismatch is a loud non-zero exit, never swallowed.
- Hermes hermes_cli/kanban_db_dispatch.py: every heartbeat and reclaim
  update is fenced on current_run_id / claim_lock (heartbeat_worker,
  _defer_reclaim_for_live_worker); a worker whose run was reclaimed is
  told to exit (adopt_worker_pid).
- Classic form: Kleppmann's fencing token — a lock holder paused past its
  lease must have its late write rejected by a monotonic token.

Lift. `work_items.claim_epoch INTEGER NOT NULL DEFAULT 0`, incremented by
`take`; dispatch passes it to the lane (env + brief). One helper
`transition(id, to, {fromStates, owner, epoch})` replaces `setState` on
the done/fail/release/start paths; zero changes is a non-zero exit naming
expected vs actual. Test: two concurrent done/reclaim on one item —
exactly one wins.

### 2. One liveness verdict for reclaim, and "unknown is not dead"

Fleet gap (verified in code). `work reclaim all` (work.ts:1320) decides
death from transcript mtime alone (`liveTranscript` → `transcriptPath`,
work.ts:748, 15-minute floor). It ignores three stronger signals the fleet
already has:

- the governor heartbeat — sessions.hb advances on every tool call
  (governor.ts, W9);
- the lane-liveness surface (`laneAlive`: process args + worktree cwd),
  whose header says "three consumers, one truth" — reclaim is not one of
  them;
- the monitor's doctrine "lookup failure is never death" (monitor.ts,
  W51). A glob error returns null, which reclaim reads as dead. A lane
  inside one tool call longer than 15 minutes (bench, build, long test)
  is reclaimable while alive.

Precedent.

- Gas City cmd/gc/detached_probe.go: tri-state probe — alive holds, dead
  releases, probe error releases only after detachedProbeErrorThreshold =
  3 consecutive errors. execution_backstop.go records the lesson as
  "never nudge on 'we cannot tell'" (#312).
- Hermes tools/kanban_tools.py (#31752): the agent's own activity is
  bridged to last_heartbeat_at (rate-limited to one write per 60 s) so the
  watchdog does not reclaim an active worker; an explicit heartbeat tool
  lets a worker pre-extend its claim across a known-long operation. If a
  reclaimed worker survives termination, the claim is extended 120 s and
  retried rather than spawning a duplicate beside it.

Lift. `reclaim all` uses `laneAlive(l) || hbFresh(sid)`; probe returns
alive/dead/unknown; unknown never releases; dead must repeat on N
consecutive passes (counter in facts, N=3 default). Add
`work extend <id> --for 45m --note "<why>"` for known-long ops, written as
a heartbeat plus note. Touch points: hooks/bin/work.ts (reclaim),
hooks/lib/lane-liveness.ts (tri-state).

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
  are fingerprinted (pids/timestamps stripped) so same-root-cause failures
  group.
- Gas City: crash-loop quarantine, max_restarts default 5 per
  restart_window default 1h (internal/config/config.go); review quorum
  separates failure class (none / transient / hard) from verdict
  (internal/reviewquorum/types.go).
- Grid precedent already in W437: Dask's three-worker-death KilledWorker,
  BOINC max_error_results.

Lift. Build W437 item A with Hermes' classification: a fruitless claim
increments fail_count only when the exit was not infrastructure and not a
quota wall (the quota sweep already knows); "lane exited, commits exist,
no work done" is a protocol violation with its own budget of 3 and a retry
brief that says "verify the prior run's commits and close"; inject the
previous attempt's last error into RESUME CONTEXT. Add `--cause` (W436
item 3) plus a transient|hard infra flag.

### 4. Deliver directed messages into a running lane (steer vs follow-up)

Fleet gap. toto-gpt.md already flags it: "a WS subscription is not proof
that a new question reaches the model's active context." Directed events
are read at SessionStart (hooks/session-start.ts) and then only when the
lane runs `coord inbox` itself — the brief asks for it twice, "before
planning and again before finishing". Nothing delivers mid-work. The
PostToolUse gate (gates/files.ts) only formats, and the dialect libraries
already emit additionalContext for claude, codex, copilot and grok.

Precedent.

- pi-mono packages/durable ("Busy Conversations"): input to a busy agent
  is queued with an explicit placement — a steer lands after the current
  tool round, a follow-up after the run answers, reject refuses; queued
  items survive a failed run.
- Gas City internal/nudgequeue: persisted pending / in-flight / dead
  queues with attempts, lease, deliver_after and expiry; bounded observe →
  nudge → back off → give up.

Lift. In the PostToolUse gate: if events with target = \<sid\> sit past the
lane's cursor, inject them as additionalContext (steer) and advance the
cursor (the bus already advances only past SHOWN). Consults get a
deadline; undelivered past it moves to dead and emits consult.expired
(W436 item 4).

### 5. Paired-arm evals before changing briefs or protocols

Precedent. pi-mono packages/evals: each case runs in isolated without_docs
and with_docs containers, with repetitions; the report pairs arms and
computes lift. arXiv 2609.05933 (Sept 2026) warns that multi-agent
efficiency gains are often setup-dependent and overestimated — paired arms
on our own tasks are the defence.

Lift. Reuse the runner shape in blam for the comparisons toto-gpt.md
already proposes: condense on/off, consult contract on/off, steer delivery
on/off (lift 4). No new infrastructure: blam scenarios × two arms ×
repetitions.

## Adopt-later (trigger-conditioned)

- Hash IDs (beads engdocs/COLLISION_MATH.md: birthday-bound adaptive
  length, nonce retry). Trigger: work items minted on more than one hub
  (W422.9). Sequential work_sequences IDs collide across offline writers.
- Config-drift restart (Gas City health patrol: SHA-256 of command + env
  per session; drifted sessions drained and restarted). Trigger: lanes
  observed running a stale install after a `version:` bump.
- Reliability report by model / prompt version (Gas City
  internal/reliability, read-only over existing events, issue #1254).
  Confirms W437 item B's design — derive the executor trust tally from
  events, add no new emission.

## Skip (fleet already equal or better)

- Claim-before-spawn. dispatch-next runs the CAS `work take` before
  spawning — same guarantee as Gas City's tracking-bead-before-dispatch.
- Gateway retry and cooldown. buckle/src/cooldown.ts already ports
  LiteLLM's retry-after-aware backoff and outlier ejection; Hermes'
  credential-pool cooldowns add nothing.
- File reservations and pre-commit guard (Agent Mail). Built for agents
  sharing one working tree; fleet lanes use per-item worktrees plus
  governor locks.
- PID fingerprinting (Hermes: boot epoch + process start time). Fleet's
  sid-in-args check (HARNESS_ARG_RE) already defeats recycled pids; the
  boot epoch only matters for pids persisted across reboots.
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
Ray. Its two adopt-now items are still unbuilt, and the harness code above
now independently confirms both: Gas City ships crash-loop quarantine and
a read-only reliability report; Hermes ships failure budgets with an
infrastructure carve-out. Build them as lift 3.

One distributed-systems nugget W437 did not cover: fencing tokens
(lift 1). BOINC never needed them because results are validated after the
fact; the fleet does, because a stale lane can mutate the ledger directly.

## Sources

- beads: PROPOSAL-cas-conditional-update.md,
  engdocs/COLLISION_MATH.md, docs/multi-agent/coordination.md —
  github.com/steveyegge/beads
- Gas City: engdocs/architecture/health-patrol.md, cmd/gc/detached_probe.go,
  cmd/gc/execution_backstop.go, internal/nudgequeue/state.go,
  internal/reviewquorum/types.go, internal/reliability/reliability.go,
  internal/config/config.go — github.com/gastownhall/gascity
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
