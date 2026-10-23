# W1143 — race-vs-single benchmark

Does racing N cheap lanes and letting a judge pick beat one strong lane?
Arms on the same sealed tasks (belt-arena, classes **b** code-gen + **e**
decision):

| arm | legs | sampling |
| --- | --- | --- |
| `strong` | 1 × :8903 (Qwen3.5-35B) | greedy (temp 0) |
| `cheap` | 1 × :8902 (Qwen3-4B) | greedy (temp 0) |
| `race` | 3 × :8902 concurrent, temp 0.7 → blind pairwise tournament on :8903 + skeptic per-rule verify → winner scored mechanically | sampled |
| `race-oracle` | derived, zero extra cost | best-of-3 by the mechanical checker |

`race-oracle` is the no-judge upper bound: it isolates how much of the
race's gain the judge selection actually recovers.

## Run

```sh
bun packages/suspenders/bench/w1143/run.ts --classes b,e --n 12 --lanes 3
```

Gates: refuses without `/tmp/bench-ac-ok` (operator-owned, same convention
as the belt arena) or on any task-manifest hash mismatch; preflights both
tiers first. Rows land NDJSON in `results/w1143-<ts>.jsonl`: one `attempt`
row per leg, one `tournament` row per race, one `summary` row.

## Scoring

Mechanical (`belt/bench/arena/scoring.ts` checkers) is the ground truth for
every arm — the judge only selects among race attempts; its selection error
is part of the race arm's measured pass rate. The skeptic walks the
tally-ranked attempts and vetoes rule violations; all-vetoed = honest null
(the race fails the task).

## Honesty notes

- **Judge bias**: blind slots (no attempt ids, arms, or temperatures in the
  prompt) + randomized presentation order per comparison; fresh context per
  call. Same-family judge (35B vs 4B candidates) can still be
  self-preferential in ways blind slots cannot exclude — the
  oracle-vs-winner gap measures it.
- **Queue serialization**: concurrent attempts may serialize inside MLX.
  `serial = sum(walls)/max(walls)` (1 = fully parallel, ≈lanes = serialized)
  is recorded per race and averaged in the summary; the race wall reported
  is `max(attempt walls) + judge wall`, never the optimistic min.
- **Cost accounting**: judge tokens/wall are measured separately (the race
  arm's coordination overhead) — the race must beat strong on
  quality-per-total-token, not on attempts alone.
- **n = 24** sealed tasks is smoke-grade vs the ≥130-paired benchmarks.md
  doctrine: directional evidence for the dispatch-pattern decision, not a
  published quality claim.
