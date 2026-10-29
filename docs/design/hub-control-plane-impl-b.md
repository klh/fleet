# Hub control plane — implementation log, fork B (phases 5–6)

Design: [hub-control-plane-consult-knowledge.md](hub-control-plane-consult-knowledge.md).
Branch `worktree-agent-a54e533c50c9984e8`. Nothing pushed or merged, and no
live DB or service was touched (except the incident described under
Findings).

## Commits

| sha        | subject                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `fe6aa8ab` | hub-control-plane phase 5: governor daemon in store-server + one coord subscriber per machine |
| `ebc160bd` | gate daemon: lane identity walks the gate client's process ancestry                           |
| `07a91c48` | hub-control-plane phase 6: controller lease holder is the only supervisor                     |

## Phase 5a — hub governor daemon

- `hooks/gate.ts` is now a thin entry. For `pre-read`, `pre-bash`,
  `pre-files`, `governor` and `push`, when `SUSPENDERS_GATE_DAEMON=1` is
  set, it POSTs `{raw, env, cwd}` to the store-server at `/gate/<event>`.
  The request uses the store token, is loopback-only and has a
  `SUSPENDERS_GATE_DAEMON_TIMEOUT_MS` timeout (default 1500). Any failure
  (unreachable, bad status, schema drift) falls back to evaluating the gate
  locally, so it fails closed, never open. All other events stay per-call.
- The event switch moved to `hooks/gate-dispatch.ts`, which imports each
  gate lazily per event. This also cuts the cost of a per-call run.
- `hooks/lib/gate-daemon/` holds the pieces:
  - `schema.ts` — zod shapes.
  - `client.ts` — the client.
  - `host.ts` — runs gates one at a time. For each request it swaps env,
    cwd and argv, captures stdout/stderr, and turns `process.exit` into a
    first-exit-wins sentinel.
  - `route.ts` — inside the daemon the store is forced to
    `GOVERNOR_STORE_URL=local` (a nested curl `spawnSync` would deadlock).
    After the run, the events the gates wrote are re-published through
    `maybeBroadcastInsert`.
- Identity: the client pins `SUSPENDERS_GATE_CLIENT_PID`, and
  `resolveFleetLane` walks that pid's ancestry. Without it, the daemon
  would walk store-server's ancestry and miss every lane, so push-guard
  would fail open. The spec proves the fix with a wrapper pid that is the
  parent of gate.ts but not of the store, and the test fails when the pin
  is removed.

## Phase 5b — one coord subscriber per machine

- `coord subscribe --machine` opens a single WebSocket with `as=*`. It fans
  events out as follows:
  - **Targeted event:** appended to `coord-subscribe-<target>.log`, then the
    Claude wake signal and the Codex delivery chain run.
  - **Untargeted event:** appended once to `coord-subscribe-_all.log`.
  - **On every connect:** it catches up pause/resume control for each
    RUNNING session.
- The push gate tails the session's own log and also `_all`. A lane's
  first read of `_all` starts at the end of the file, so it never replays
  history.
- `SUSPENDERS_SUBSCRIBE_MODE`:
  - Default is `machine`.
  - `session` is the legacy per-sid socket, kept as an escape hatch.
- Subagents (`#agent-` in the sid) never open a subscriber.
- Liveness is scoped to HOME through `coord-subscribe-machine.pid`. A
  global pgrep matched other HOMEs and test stubs. A subscriber that has
  been superseded exits within 30s.

## Phase 6 — one supervisor

- `hooks/lib/lanes/session-contract.ts` defines `isControllerSession`. It
  is true when the live fleet-loop controller lease holder is an ancestor
  of the session. If the lease is absent, unknown or held by a
  non-ancestor, the session is a worker.
- SessionStart renders SUPERVISOR DEFAULT/CONTRACT and the report table
  only for the controller session. Every other top-level session gets the
  **WORKER CONTRACT**: work owned and READY items, never arm a refill loop
  or run a reclaim sweep, and manual `dispatch` stays allowed when the owner
  asks.
- The mid-session refill (push gate) checks the same predicate.
- Escape hatch: `SUSPENDERS_SESSION_CONTRACT=supervisor`.

## Tests

- New specs:
  - `hooks/lib/gate-daemon/gate-daemon.e2e.ts` — 7
  - `hooks/coord/subscribe-machine.e2e.ts` — 4
  - `hooks/lib/lanes/session-contract.e2e.ts` — 5
  - Total: 16 passed.
- `session-start-supervisor.test.ts` was rewritten for phase 6 and passes
  8/8.
- `subscribe-attach` and `subscriber-claim-lifecycle` are pinned to
  `session` mode, because they test the per-sid lifecycle contract.
- Regression set (22 files): 267 pass, 12 fail. All 12 failures also fail
  on a detached baseline worktree at `eb8b894c` (13 fail there):
  - push-guard real-spawn timeouts
  - `fact set` arg-null
  - HTTP transport
  - UI-law filesCheck
  - nested sudo

## Gate latency

Measured with `scripts/gate-bench-latency.ts` in a scratch HOME and store.
Values are p50 in ms, n=9, with a warm-up run discarded.

| event     | eager imports (before, live HOME) | lazy per-call | daemon |
| --------- | --------------------------------- | ------------- | ------ |
| pre-read  | 38                                | 28            | 27     |
| pre-bash  | 55                                | 58            | 29     |
| pre-files | 235                               | 179           | 62     |
| push      | 54                                | 34            | 28     |

About 25ms of each call is the floor for `bun` process start plus stdin.
The daemon removes the cost of the gate graph, not the cost of the spawn.

## Behaviour changes on install (live sessions)

- **Machine subscribe mode is the default.**
  - New sessions spawn or reuse one machine socket.
  - Existing per-sid subscribers keep running until their staleness exit,
    so targeted lines can be duplicated during the transition.
  - `reapSubscribe` and `reapIfIdle` only reap per-sid sockets.
  - In machine mode the per-session rename watcher and the W494 staleness
    exit do not exist.
- **Interactive sessions now get the WORKER CONTRACT.** Sessions that were
  acting as supervisors lose the SUPERVISOR DEFAULT and refill prompts
  unless the controller launched them.
- **Lazy gate imports are always on.** The daemon is opt-in only
  (`SUSPENDERS_GATE_DAEMON=1`).

## Findings

- **C174 self-conflict.** The governor's per-file lease on
  `scripts/gate-bench.ts` was held by this fork's own sid under an older
  state token. It denied the fork's later edits to the same file and opened
  consult C174 to the parent on the live plane, because the first bench ran
  against the real HOME. This is the per-session governor inefficiency that
  phase 5 replaces. The bench now runs fully isolated.
- **Leaked test stub.** An early unpinned `subscribe-attach` run leaked a
  stub `coord.ts subscribe --machine` process: a `setInterval` loop under
  `$TMPDIR/subscribe-attach-*`. The auto-mode classifier blocked killing
  it, so it is still running and needs manual cleanup. The pidfile change
  makes it harmless.

## Reviewer risks

- Gates run inside the store-server process. A gate crash or hang there
  stalls the coord plane. The 1500ms client timeout bounds the impact on
  callers, but not the impact on the server.
- First exit wins: gate code that catches the sentinel inside its own
  try/catch could keep running after the decision.
- Requests are serialized, so one slow `pre-files` (qlty) delays the other
  gates queued behind it.
- Events that gates write inside the daemon are published only after the
  run finishes.
- A small race remains when two machine subscribers start at once. The
  pidfile check happens before the write, and the loser exits within 30s.
