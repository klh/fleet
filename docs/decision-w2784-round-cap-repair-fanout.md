# W2784 round-cap repair fan-out — the plan record (W2792)

Survey-verified 2026-11-06 (W2784 lane, consumed by W2792): all 16 stalled
review items sit at 5–6 failed review rounds vs cap 3 — `scheduleReview`
refuses them forever (the `review-round-cap.ts` lineage walk counts
ancestors' failed rounds); pushing fixes to their branches cannot re-fire
review. The graph-native escape is a fresh parentless vehicle item, which
starts rounds=0 — the same mechanism that minted W2691–W2712.

## Decision

Children are minted **per repair carrier, not per capped id**:

| child | carrier | scope |
|---|---|---|
| W2784.1 | W2529 | empty-delta import-flip convergence — DONE (@f37e0b75, tree byte-identical to main) |
| W2784.2 | W2695 | W2262 intent-reconcile carrier — freshest PASS carrier of the W2692–W2700 nine near-identical re-lands |
| W2784.3 | W2708 | hub-orphan-gc (W2706/W2707 are earlier generations; B1 fixed in W2708's lineage) |
| W2784.4 | W2691 | dispatch-watchdog W2339 carrier |
| W2784.5 | W2712 | launchd-launcher W2676 carrier |
| W2784.6 | W2269.1.4 | lit console migration scope debt — open feature debt, repaired on a fresh vehicle |
| W2792.1 | — | review crank itself: wire-model-mismatch ERROR loop — DEGRADED reliability fix on the crank machinery, not a carrier repair |

## Rules going forward

- W2784.x children are single-scope — never re-split them (W2784's handoff
  NOTE #113462).
- Dispatch fills lanes from READY; the plan item carries no implementation.
- Each child lands its repair on a fresh vehicle branch; the capped
  originals stay capped — no un-cap knob added to scheduleReview.
