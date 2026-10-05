# BLAM labeling protocol

## Unit of labeling

One **incident**: a bounded episode where the fleet's behavior diverged from
intent, with a detectable onset, some observable course, and a terminal
state (recovered, parked, or accepted-loss). Not a unit: individual log
lines, single commands, or whole projects.

## Sources

First-party fleet records: workgraph, lane logs, coordinator logs, board
events. Second-party: incident reports from other operators (cite).
Incidents are never constructed from memory alone — cite the record or the
record excerpt in `evidence`.

## Procedure

1. Extract candidate incident from records (onset → terminal state).
2. Sanitize (see below) BEFORE drafting narrative fields.
3. Apply the decision tree (`docs/taxonomy.md`) → crash_class + subclass.
   Record the runner-up class when contested.
4. Score severity axes (docs/metrics.md): data_loss_commits, false_blocks,
   wall_clock_lost_min, undetected_min.
5. Fill detection/recovery fields; mitigations list everything that would
   have prevented or shortened the incident, whether or not it existed.
   Mitigations cite evidence when the claim is empirical (source + date).
6. `bun tools/label.ts add` (or hand-edit JSONL) → `bun tools/label.ts
validate` must pass before commit.

## Sanitization (hard rule)

- Strip: real names of private projects/repos, personal paths
  (`/Users/…`), credentials, client data, model invocation details tied to
  a person.
- Keep: mechanics, timings, log-line SHAPES (genericized), class-relevant
  structure. "repo P", "the fleet's merge ladder", "lane autowN" are fine.
- A record that cannot be sanitized without losing the lesson is recorded
  as class `unspecifiable` in notes and excluded from stats.

## Multi-annotator agreement

- Seed records are labeled by the primary annotator (single label).
- A second annotator independently labels a 25% sample (min 25 records)
  using only the taxonomy doc + decision tree — not the primary labels.
- Agreement = Cohen's kappa on crash_class (tools/stats.ts kappa()).
- Target: κ ≥ 0.7 (substantial). Below target: revise definitions, re-label
  the sample, re-measure. Report final κ in the paper.
- Contested records are adjudicated by the taxonomy maintainer; the
  adjudication log lives in `dataset/adjudication.md`.

## Metrics

Severity and benchmark metrics are defined in `docs/metrics.md`; label
severity axes before recovery fields — recovery actions change the
counterfactual.
