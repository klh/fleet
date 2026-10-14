# loop/GUI/monorepo organization review — 2026-10-14

Trigger: owner reported 'loop bugs and inconsistencies in the gui and organization of the monorepo'. Oracle analyze (claude-opus-5-5 attempted; Copilot seat quota-walled for large calls — landed on local :8903 Qwen3.5-35B) over a digest of orchestration file sizes, board route surface, payload keys, and eight coordinator-observed loop defects from live ops 2026-10-12/13.

## Verdicts (ranked by operator pain)

1. Loop/refill semantics — CRITICAL. Two capacity truths (dispatch default 6 vs owner directive 7); FAILED items silently leave READY so pools 'drain' over dead work; three uncoordinated reconciliation cadences (coordinator tick, quota-sweep, monitor).
   Contract: STRICT QUEUE — READY is the only queue dispatch reads; drain requires READY empty AND FAILED reconciled; one capacity knob in config.
2. Board GUI — HIGH. /api/data monolith 253-712KB per poll; syncDecisions on read paths; operators cannot tell live from stale.
   Contract: EVENT-STREAM — per-panel feeds, server-pushed deltas over the W303 WS bus; no polling monolith.
3. Monorepo organization — MEDIUM. suspenders is a god-package (loop + dispatch/hooks + GUI routes); root law vs package-law drift.
   Contract: DOMAIN SPLIT — core (state/loop), runner (dispatch/hooks), ui (routes/payload); AGENTS.md as interface contract, not prose.

## Named risks
- FAILED→READY reconciliation must be atomic in any loop rework.
- WS push must batch deltas or per-panel overhead eats the win.
- .prefer must-rungs need parse-time validation against enabled executors (the claude-fable-5-1 rung killed 4 lanes before diagnosis).

## Full model output

WHAT: The system suffers from a "distributed state of mind" where orchestration logic, GUI data, and repo boundaries are entangled, causing operator confusion, silent data loss, and massive network bloat.

HOW:
*   **Loop/Refill Semantics:** Replace the current "tick-and-merge" heuristic with a **State-Transition Machine (STM)** contract where `READY` is a strict, single-source-of-truth queue; `dispatch` is a pure consumer of that queue; and `drain` is a terminal state requiring explicit `FAILED` reconciliation before pool closure.
*   **Board GUI Structure:** Shatter the 712KB `/api/data` monolith into **per-panel GraphQL-like subscriptions** (e.g., `/lanes`, `/decisions`, `/zombies`) with server-side pagination; eliminate `syncDecisions` on read paths by moving decision logic to the write path (CQRS).
*   **Monorepo Organization:** Split `suspenders` into `@fleet/core` (state machine, loop logic), `@fleet/orchestrator` (dispatch, hooks, bin scripts), and `@fleet/gui` (routes, payload); enforce `AGENTS.md` as a strict interface contract between packages, not a documentation file.

RISKS:
*   **State Divergence:** Refactoring the loop to an STM risks breaking existing "intent" workflows if the migration of `FAILED` -> `READY` reconciliation logic is not atomic.
*   **Latency Spike:** Moving from a single large payload to per-panel feeds may increase connection overhead if the client doesn't implement efficient WebSocket batching.
*   **Context Loss:** Splitting `suspenders` risks losing the tight coupling between `loop` and `board` if the new `@fleet/core` doesn't expose a clean, typed event bus.
*   **Operator Blindness:** Removing the "one line" status from the loop output during migration may hide critical `READY=0` states if the new STM doesn't emit a `DRAIN` event immediately.

OPEN QUESTIONS:
*   What is the exact definition of "intent" in the `REFUSED` logs—is it a database row, a file lock, or a memory state?
*   Does the `quota-sweep` service have a dependency on the `loop` tick, or can they be decoupled into independent event consumers?
*   Are the `worktrees` and `registry prune` operations idempotent enough to be run as a separate cleanup service without race conditions?
*   Is the `TARGET` variable (6 vs 7) a configuration error or a feature of "owner directives" that needs to be moved to a config store?

**RANKING BY OPERATOR PAIN (Most Critical First):**

1.  **Loop/Refill Semantics (Critical):** The "two sources of truth" for capacity (default 6 vs directive 7) and the silent `FAILED` drain are causing immediate operational failure (blocked dispatches, invisible slots).
    *   *Sane Contract:* **The "Strict Queue" Contract.** `READY` is the only source of truth for dispatch. `dispatch` reads `READY`, claims a slot, and *only* then updates the lane state. No "ready" items exist until claimed. `drain` is impossible until `READY` is empty AND `FAILED` is reconciled.
2.  **Board GUI Structure (High):** 712KB payloads and `syncDecisions` on read paths create latency and confusion; operators cannot distinguish live vs. stale data.
    *   *Sane Contract:* **The "Event-Stream" Contract.** No polling. The GUI subscribes to `lane-state-changes` and `decision-events`. The server pushes only deltas.
3.  **Monorepo Organization (Medium):** `suspenders` is a "god package" mixing orchestration, hooks, and GUI logic, making debugging and testing impossible.
    *   *Sane Contract:* **The "Domain-Driven" Contract.** `@fleet/core` (state), `@fleet/runner` (dispatch/hooks), `@fleet/ui` (routes). No cross-package imports of implementation details, only interfaces.
oracle: analyze route=local-reason model=mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit ms=17424
