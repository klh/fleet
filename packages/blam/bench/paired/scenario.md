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
| resume-bounded  | retake resumes pass 1's transcript within the freshness gate (W622) | fresh lane + brief/AGENTS.md/capsule re-injection          | scripted transcript-retake model          |
| resume-long     | same, on a long-pass transcript (220k tok)                          | fresh lane + brief/AGENTS.md/capsule re-injection          | scripted transcript-retake model          |

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
- **resume-bounded / resume-long** — rep r rides the retake delays
  `[1, 2, 4, 5]` min. Every delay sits INSIDE the 5-min prompt-cache TTL:
  the dispatch knob only honors `--resume-from` while the prior
  transcript is cache-warm, so beyond-TTL retakes are refused before the
  resume arm exists (both arms are the same fresh lane — no cell to
  measure). The delay is the cell identity; within the gate the re-read
  is cache-priced regardless of the exact minute.

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
- resume-bounded / resume-long: the resume arm pays pass-1 tokens at the
  0.1× cache-read rate (`CACHE_READ_RATE`) + 1 min reload (the transcript
  IS the context — no re-orientation); the fresh arm pays the O(1)
  re-injection `FRESH_INJECT_TOKENS` (brief 2k + AGENTS.md 4k + capsule
  0.15k + orientation re-reads 10k) + 6 min orientation. Quality: the
  resumed lane keeps full context but inherits pass-1 rot (bounded 1.0,
  long 0.75 — dead ends scale with transcript length); the fresh lane is
  rot-free but a ≤10-line capsule cannot carry a long pass (bounded
  0.95, long 0.85). Declared assumptions, not measurements — the live
  arm rides the additive track on the same `RepOutcome` schema.

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
6. P6 — the resume freshness gate is structural: every scheduled retake
   delay sits inside the cache-TTL gate, the bounded class is
   cache-cheap, and the long class genuinely contests the injection
   cost (the arms are not vacuously identical).

## Decision rule (W622 retake knob)

Pre-registered before reading the lift (`resumePolicyVerdict`,
`RESUME_KNOB_RULE`): the resume knob covers a retake class iff the
resumed lane never loses correctness (4/4 non-neg) AND saves tokens and
minutes with ≥3/4 sign agreement. The dispatch policy lands from the
SAME verdict the report prints — bounded-class retakes (≤~10 min of
prior-lane work) claimable with `--resume-from <session-id>` only while
the prior transcript is cache-warm; everything else stays fresh-lane +
capsule (the doctrine default).

## Reading the report

`bun packages/blam/bench/paired/harness.ts` prints per-arm means and the
lift line per case, exits non-zero if a property breaks. Expected
headline: condense saves ~30% of the brief budget at zero correctness
loss; the consult contract and steer delivery both save tokens + minutes
and fix tasks (correctness lift > 0) — with the consult case riding the
W447 matrix so the lift already averages over KB freshness and delivery
health, exactly the setup-dependence the paired design neutralizes.
The resume cases print one `knob <class>: RESUME|FRESH` line each —
W622's measured verdict: bounded RESUME (+10 150 tok, +5.0 min, +0.05 ok
per rep), long FRESH (−5 850 tok, −0.10 ok per rep: the 22k cache-priced
re-read of a 220k transcript already exceeds the 16k injection before
rot is charged).
