# W1072 — reclaim-liveness supersession decision

Recorded 2026-10-25 by lane autow1072-p98b319584008df14 at parent close.

## Situation

Mission (2026-10-20): a crashed lane's claim stayed CLAIMED forever — a
recycled pid read as liveness, existence-based transcript checks kept cold
claims warm, and an orphaned coord subscribe sidecar held the session
heartbeat up. `work reclaim --force --reason crash` refused with
"claimant liveness is alive, not verifiably dead".

This lane's branch (suspenders/W1072, six commits, 2026-10-21) took the
protection direction: stale-heartbeat manual claims read unknown (never
death), reclaim liveness is fenced to the exact work item, worktree
retirement rechecks the live claim, and managed-wrapper registry pids get a
fenced repair path (registry-pid-repair.ts).

Child W1072.3 (2026-10-24, landed in main at 30dcc07a) superseded that
direction with the behavioral contract: pid identity is start-time bound —
a process on the recorded pid that began after the lane launched is a
recycled pid and never liveness; coord subscribe sidecar args are never
lane evidence; transcript existence is freshness-floored. The wedge shape
(recycled pid + cold heartbeat + open session row) converges dead ×3 →
release. Pinned by packages/suspenders/test/reclaim-liveness-contract.test.ts.

## Decision

The W1072.3 contract in main is canonical. The branch's reclaim-liveness
delta (zombie-window death-evidence removal, transcriptAlive unbinding) is
retired — it is never merged; merging it would weaken the landed contract.
The branch's complementary fencing work stays on suspenders/W1072 as a
reference; porting any of it is a separate decision.

## Evidence at close

- 112/113 across the branch's touched suite; the single failure
  (dispatch-next "legacy session prefix collisions") fails identically on
  the claim baseline 361f9336 — pre-existing, not a branch regression.
- W511 closing-diff scan clean; W833 scan clean apart from the branch's
  intentional zombie-test rename (retired together with its delta).

## Consequences

- W1072 closes as the parent of three done children
  (W1072.1 health-pause attribution, W1072.2 merge-DONE+sha gate,
  W1072.3 supersession + behavioral contract).
- Integration of suspenders/W1072 remains a separate decision; main
  carries the contract regardless.
