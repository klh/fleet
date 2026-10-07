# Consult evaluation harness — scenario spec (W447)

Deterministic, LLM-optional comparison of three consult policies on
matched task sets, per the evaluation contract in toto-gpt.md § "How to
evaluate whether it works". Lanes are policy stand-ins; the consult
plane is a scripted backend. No model calls — the live-agent track rides
additively later on the same metric schema.

## Arms (data, not code paths)

| arm | trigger | KB first | version-check |
| --- | --- | --- | --- |
| current-instructions | second unchanged failure | no | — |
| trigger | observable trigger at the decision point | yes | no |
| trigger+verified-reuse | observable trigger at the decision point | yes | yes |

## Matched task profiles

| profile | plane setup | what it isolates |
| --- | --- | --- |
| shared-api-uncertainty | live expert holds the contract; no KB row | failure to ask (H5) |
| migration-knowledge | verified KB row, fresh (v2) or stale (v1) variant | unverified reuse (H8) |
| conflicting-assumptions | live expert holds the resolution | H5 with a shipped wrong assumption |
| no-consult-control | no expert, no row | false consults / wasted calls |

Every arm runs the same four tasks (t1–t4) on every plane; arms differ
only in `POLICIES` data (policies.ts).

## Scenario matrix

| id | KB | delivery | isolates |
| --- | --- | --- | --- |
| fresh/ok | v2 | ok | base comparison |
| stale/ok | v1 | ok | H8: unverified reuse applies a stale row |
| fresh/drop-first | v2 | first ask per scope dropped | H6: delivery failure + retry accounting |
| stale/drop-all | v1 | every ask dropped | H6 worst case: no answers reach anyone |

## Cost model

Per unit: investigation 400 tok / 5 min; consult exchange 250 tok /
6 min latency; KB read 30 tok; redo-after-stale 600 tok / 15 min. All
policies share one cost model (`COSTS` in types.ts) and one retry budget
(`maxAskAttempts = 2`); the arms differ only in consult policy. No RNG:
same inputs → byte-identical metrics (property P6).

## Metric semantics (the W447 list)

- **consultationOpportunities** — tasks where a consult could change the
  decision (SA, MK, CA; never the control group).
- **attemptedCalls** — ask() attempts (retries included).
- **deliveryFailures** — undelivered outcomes (H6). Charged
  `consultLatencyMin` blocked time each.
- **usefulAnswers** — answered with evidence; **unhelpfulAnswers** —
  delivered but evidence-free (H7; no scripted case fires it yet).
- **appliedVerified** — KB rows applied; **staleAnswers** — KB rows
  applied against a newer code version (H8), charged redo cost.
- **blockedTimeMin** — minutes the lane cannot progress: pre-consult
  duplicate investigation (arm A) + answer waits + lost waits.
- **duplicateInvestigationUnits** — investigation units re-deriving what
  the plane already held (the cost of H5).
- **retries** — re-asks after an undelivered answer.
- **tokenCost** — investigation + consult + KB-read + redo tokens.
- **correctTasks/totalTasks** — artifact matches ground truth per task.

## Bench properties (reproduction contract)

A run scores only when all six hold (harness `checkProperties`):

1. P1 — arm A duplicates; arms B/C do not.
2. P2 — trigger applies a stale answer on the stale plane; arm C applies
   none anywhere.
3. P3 — no arm consults on the no-consult control (no false consults).
4. P4 — arm C correct on all four tasks, fresh and stale planes.
5. P5 — injected delivery drops are counted (≥1) when injected.
6. P6 — byte-identical metrics on repeated identical runs.

## Reading the matrix

`bun packages/blam/bench/consult/harness.ts` prints the table and exits
non-zero if a property breaks. Expected headline (v1 arms): arm A fails
conflicting-assumptions and burns 6 dup units; trigger-only applies the
stale row (stale=1, 3/4); trigger+verified-reuse is 4/4 on both KB
planes and avoids the stale mishap by falling through to a live consult.
