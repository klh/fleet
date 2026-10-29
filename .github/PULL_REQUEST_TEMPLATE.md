<!--
PR / landing template (W1303.5). The change sets the tier, not the author —
see how-to-review.md "What to review (risk tiers)". Rows with no real
evidence are prose: paste commands and output, never summaries.
-->

## What changed

<!-- one short paragraph: the problem, the fix, the shape of the diff -->

## Testing evidence

<!-- real commands + real output on the changed files (A/B baseline for
pre-existing reds). "Tests pass" without the command is a finding. -->

- Command:
- Output (tail):

## Risk tier

<!-- low = docs/tests/flagged-additive (0 approvals) · medium = ordinary
product (1) · high = gates/auth/secrets/infra/workflows/release tooling/
check tools (2, agent approval never fills a human slot). The merge ladder
classifies independently (hooks/lib/gates/risk-tier.ts) and defers
medium/high with a NEED_DECISION. -->

- Tier: low | medium | high
- Why this tier (paths that drive it):

## How to revert

<!-- exact commands a human can run under pressure; note any state outside
git (governor.db rows, machine conf, launchd) the revert must also undo -->
