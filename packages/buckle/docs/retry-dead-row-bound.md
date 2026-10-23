# Same-tier dead-row retry bound (W1098)

## Problem

On a network-layer failure (connect refused, first-byte timeout) the tier
walk advanced by one attempt per retry, but `candidates.at()` clamps past
the last row. A non-`connect` error skipped the old break condition, so the
final candidate was attempted again with a fresh full `request_timeout_s`.
With `num_retries: 1` over a three-tier fallback ladder that is 6 × 120 s =
720 s of dead-row time before the walk ever reached the next policy tier.

## Decision

`attemptTier` (packages/buckle/src/router.ts) breaks to the next policy
tier once the walk has consumed every candidate
(`raw >= candidates.length - 1`), regardless of error layer. A network
exchange that already spent its timeout cannot improve by repeating the
same row; the remaining walk budget belongs to the next tier.

Preserved laws:

- ordered.prefer — the tier order still comes from the canonicalized
  `.prefer` selection; this change is intra-tier only.
- same-tier advance — a failed row still walks to a DIFFERENT same-tier
  candidate before the tier is abandoned.
- skip-not-fail (W985) and the banked-rate-limit break are unchanged.

## Relation to the walk budget

The `first_byte_budget_s` walk budget (W1099) bounds the whole walk's
first-byte spend across tiers; this bound stops per-tier row repeats. They
compose: no tier re-spends its timeout on a clamped dead row, and no walk
outlives its budget.

## Verification

- `packages/buckle/test/router-dead-hub.test.ts`: the timed-out last row is
  tried once per tier and the fallback ladder receives the walk; a failed
  network row still advances to a different same-tier candidate.
- Router suites 38/38; full buckle suite 715/716 with the one failure the
  known combined-run flake in stream-outcome.test.ts (passes solo).
- Repair commit: 74283f1c.
