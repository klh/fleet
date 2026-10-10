# Paired-arm eval harness — scenario spec (W612)

Deterministic, LLM-optional paired-arm protocol per
docs/harness-lift-research.md lift 5 (pi-mono packages/evals): every case
runs isolated **with + without** arms with repetitions; the report pairs
arms per repetition and computes lift. The pairing is the defence against
the setup-dependent-gains warning (arXiv 2609.05933): both arms see the
same setup in every rep, so measured lift is attributable to the arm, not
the setup. No model calls — the live-agent track rides additively later
on the same `RepOutcome` schema (types.ts).

Run: `bun packages/blam/bench/paired/harness.ts`

## Cases (the toto-gpt.md comparisons)

| case            | on-arm                                                              | off-arm                                                    | engine                                    |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| condense        | lane reads the production caveman-condensed brief                   | lane reads the full brief                                  | the REAL blam engine (`src/condense`)     |
| consult-contract| brief carries the consultation contract (`trigger` policy)          | current instructions (consult after second unchanged failure) | the W447 consult bench (`bench/consult`) |
| steer-delivery  | steering events drain into the running lane at the next save (W611) | events reach the operator transcript only                  | scripted lane-inbox model                 |

Arms are case-family engines, not hand-written control flow: the condense
arm difference is one boolean into the real `condenseTier` engine; the
consult arms are two `POLICIES` rows from W447; the steer arms differ in
one `delivered` boolean over a shared schedule.

## Repetitions (fixed schedules, no RNG)

- **condense** — the engine is pure: reps are identical by construction
  (variance 0; the lift is exact, not sampled).
- **consult-contract** — rep r rides the W447 scenario matrix
  (`SCENARIOS[r % 4]`): fresh/ok → stale/ok → fresh/drop-first →
  stale/drop-all.
- **steer-delivery** — rep r rides `STEER_SCHEDULE`: revert@u1 →
  revert@u3 → cancel@u3 → revert@u5 (arrival = units completed when the
  steering event lands; UNITS = 6).

A repeated run is byte-identical (consult P6 discipline carries here).

## Cost model

- condense: token proxy = byte length of the text the lane reads
  (tokenizer-agnostic; every arm charged the same way).
- consult-contract: rides the W447 `COSTS` verbatim, `minutes =
  completionTimeMin + blockedTimeMin`. Known W447 gap, inherited and NOT
  silently changed: `COSTS.consultTokens`/`consultLatencyMin` are
  declared but never charged per successful exchange — the case's token
  lift therefore measures the dup-investigation + redo savings only.
- steer-delivery: shared `COSTS` (400 tok / 5 min per unit, 600 tok /
  15 min redo) + `DRAIN_TOKENS = 40` per delivered event; the delivered
  arm completes at most one in-flight unit past the event (the drain
  fires at the next save).

## Metric semantics

`RepOutcome { correct, tokens, minutes }` (types.ts):

- **correct** — fraction of the case's tasks whose artifact matched
  ground truth (condense: operative spans survive; consult: the W447
  correctness rules; steer: 1 unless a cancelled artifact ships).
- **tokens / minutes** — input tokens and wall time charged to the
  lane(s), blocked time included.

`pairedLift` averages WITHIN-rep deltas (`off − on` for cost, `on − off`
for correctness) and reports sign-agreement counts per rep.

## Bench properties (reproduction contract)

A run scores only when all five hold (harness `checkProperties`):

1. P1 — pairing identity: rep indices exact, setups labelled per rep.
2. P2 — condense meaning guard: caveman keeps every operative span on
   every case brief, and the aggressive tier genuinely strips the
   hedge clause (the arms are not vacuously identical).
3. P3 — no false consults: neither consult arm asks on the
   no-consult control task.
4. P4 — steer drain bound: the delivered arm never costs more (tokens
   or minutes) and never scores lower than the undelivered arm.
5. P5 — injected delivery drops are counted on the drop plane.

## Reading the report

`bun packages/blam/bench/paired/harness.ts` prints per-arm means and the
lift line per case, exits non-zero if a property breaks. Expected
headline: condense saves ~30% of the brief budget at zero correctness
loss; the consult contract and steer delivery both save tokens + minutes
and fix tasks (correctness lift > 0) — with the consult case riding the
W447 matrix so the lift already averages over KB freshness and delivery
health, exactly the setup-dependence the paired design neutralizes.
