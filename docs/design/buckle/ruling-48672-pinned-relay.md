# Ruling #48672 draft — pinned-relay delivery for all-cloud pinned groups

Status: DRAFT for owner/fleet ruling — updated 2026-11-09 by pi@muramasa (W2868).
Replaces the NEED_DECISION block in `hub-canary-2026-10-20.md` § open law finding,
which is stale on its central factual claim.

## Original decision demand (2026-10-20 canary)

"A pinned ALL-cloud group can never deliver a hintless request —
`router.walkSelected`'s W209 escalation gate demands `attempts >= 2` before any
cloud row, unreachable when the group has no local rung, and `x-belt-hint` is
ingress-only so a Mac relay cannot express `must` to the hub. Until ruled,
hub-relayed Copilot pins surface 502 `no_route`; `must cloud` direct to the hub
is the working path."

## Fresh evidence (2026-11-09, in-process spoke face)

`bun packages/buckle/bin/copilot-seat-proof.ts --pinned` (PAT via
`src/copilot-pat.ts` → provider profile), live Copilot seat:

| leg | hint | result |
| --- | --- | --- |
| must-cloud | `must cloud` | **PASS** — 200, `tool_use get_weather`, real usage |
| pinned-hintless | none | **PASS** — 200, `tool_use get_weather`, real usage |

The hintless pinned explicit-model call DELIVERS. Reproduction command above;
machine policy `repo-tier-policy.yaml` active (1 class), owner cloud gate open.

## Why the old refusal no longer reproduces

The pin walk is post-W209 law (`decide.ts`, W690/W709 lineage):

1. **W690 explicit-model law** — the model string is a PIN: candidates scope to
   the named group's rows; no substitution behind the client's back.
2. **W709 owner-gate law** — the owner-gate filter binds pinned rows: a pinned
   cloud group with the gate closed refuses loudly (`cloud_forbidden`, "pins
   never substitute"); a mixed pin delivers its local rows.
3. The W209 escalation gate governs pool-wide prefer/no-hint heads; a PIN's
   candidate set is its own group's viable rows, which head directly when the
   gate is open.

Net current law: **pinned all-cloud groups deliver hintless requests at
attempts=0 when the owner cloud gate is open, and refuse loudly when it is
closed. Both behaviors are the designed ones** (pin = explicit client demand,
same trust level as `must`).

## Residual decision space

- **(a) Close #48672 as fixed-by-design** (recommended): the refusal scenario
  is gone; loud `cloud_forbidden` covers the gate-closed case; substitution is
  impossible by pin law. Document in the canary + this draft; no code change.
- **(b) If relay-face `must` propagation is still wanted** (a Mac relay
  expressing a hint to a hub for NON-pinned traffic), that is a separate
  feature (egress-side hint header), not a #48672 blocker.
- **(c) Gate-closed pinned refusal UX** — the `cloud_forbidden` error already
  names the pin and the law; test coverage exists in decide tests.

## Verification commands

    bun packages/buckle/bin/copilot-seat-proof.ts --pinned-only   # hintless pin leg
    bun packages/buckle/bin/copilot-seat-proof.ts --pinned        # both legs
