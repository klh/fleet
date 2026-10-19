# Failed-lane recovery paths

Review record of W858.7.3.2 (2026-10-20): the failed-lane lifecycle and its
recovery surfaces on the work graph + fleet board.

## Recovery surfaces (all landed)

- **`work retry <id>`** (W761) — the requeue verb: FAILED → READY; releases
  stale claims, resets the launch budget, drains the open budget flag
  (`hooks/lib/work-retry.ts`). Also retries budget-quarantined READY items
  (W787) — the post-outage "dispatch silently drained" class.
- **`quota-lift-retry`** (W804) — a W779 calendar task auto-requeues review
  legs parked on provider quota walls at their gate date; self-retiring
  (`hooks/lib/quota-lift-retry.ts`).
- **`work reclaim [all]`** — dead lanes' CLAIMED/RUNNING/ORPHANED claims →
  READY; CAS-guarded on the board release path (W873). FAILED is deliberately
  not reclaimable — retry is the FAILED path.
- **`work fail`** — owner-gated to the claim holder on CLAIMED/RUNNING.
- **`cancel` / `supersede`** — refuse already-closed states.
- **W743 repro-first** — re-minting a FAILED id requires failure evidence.
- **dispatch gates** (`scripts/dispatch-next.ts`): FAILED + NEED_DECISION are
  operator-gated, never auto-dispatched; the W896 verdict-repeat gate flips a
  verdict-echo capsule to the operator-gated class instead of re-spawning.
- **Board evidence face** — FAILED rows carry failure_note + a 320-line
  transcript tail (`hooks/board/data.ts`), rendered as `kfailure` + `ktail`
  on the card (`hooks/board-html/tasks.ts`).

## Live FAILED set (2026-10-20) — correctly classed

- **W491** operator-gated: owner relay config + tokens; retry would
  mis-class it.
- **W552** operator-gated: owner Screen Studio capture (Computer Use denied
  for iTerm2 — do not bypass).
- **W738** quota-gated: W804 auto-lifts at ~2026-11-01.

## Gaps found

1. **FAILED cards are evidence-only** — no requeue action. `work retry` is
   CLI-only; the board offers release (live claims) + cancel + second
   opinion, nothing for FAILED. A card-native requeue (`/api/retry`
   mirroring the CLI verb + a retry button on FAILED cards) is the missing
   actionable recovery. Follow-up item minted.
2. **`work retry` has no operator-task guard** — retrying an operator-gated
   FAILED item (W491 class) re-arms it for auto-dispatch. Safe today only
   because retry is a deliberate manual verb; a card button makes that guard
   load-bearing, so the follow-up endpoint should refuse operator-class items
   or gate on an explicit force flag.
