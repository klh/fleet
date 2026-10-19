# BLAM-bench

Deterministic, **LLM-optional** reproduction scenarios for control-plane
failure classes. Each scenario seeds a known failure condition with
_scripted lane stand-ins_ (plain processes — no model calls), runs the
control plane under test, and scores the properties in `docs/metrics.md`:
property satisfaction, TTD, TTR, false-block rate. A scenario must
reproduce ≥9/10 runs.

## Scenario suite (v0)

| id  | CRASH class                 | failure seeded                                                     | property scored                                                 |
| --- | --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| S1  | C1 registry-lag             | branch created before its registry entry; sweep runs in the window | no false retire of a mid-spawn lane                             |
| S2  | C2 liveness-forgery         | merge-runner marker with a recycled pid                            | debris is healed, not deferred                                  |
| S3  | C3 check-then-act           | park-rename between sweep and retire                               | no retire on a vanished branch                                  |
| S4  | R1 debris-blocks-recovery   | kill a ladder run mid-merge with staged content                    | debris cleared within one cycle; next branch not falsely failed |
| S5  | S1 foreign-merge-conclusion | `git commit` while MERGE_HEAD + live marker                        | commit refused, or no two-parent commit                         |

Each scenario is a driver in `crash/scenarios.ts` over the shared world
model (`crash/scenario.md` § world model): real git fixture (refs,
MERGE_HEAD, staged content are real git state) + scripted stand-ins, so
repeated runs are byte-identical. Reference implementation of S1-S5:
`crash/harness.ts` — run `bun packages/blam/bench/crash/harness.ts`.

## Consult policy suite (W447)

`consult/` — deterministic, LLM-optional comparison of three consult
policies (current instructions, trigger, trigger+verified-reuse) on
matched tasks, with injected delivery failures and a stale-KB plane.
Scores the W447 metric list (attempted calls, delivery failures,
useful/applied answers, stale answers, blocked time, duplicate
investigation, token cost) and holds six reproducibility properties.
Spec: `consult/scenario.md`. Run:
`bun packages/blam/bench/consult/harness.ts`.

## Paired-arm eval suite (W612)

`paired/` — deterministic, LLM-optional paired-arm runner per
docs/harness-lift-research.md lift 5 (pi-mono packages/evals): three
brief/protocol comparisons (condense, consult-contract, steer-delivery)
each run with+without arms over fixed repetition schedules; the report
pairs arms per rep and computes lift — the defence against the
setup-dependent-gains warning (arXiv 2609.05933). Condense rides the real
`src/condense` engine; consult-contract reuses the W447 bench arms; steer
models the W611 gate drain. Spec: `paired/scenario.md`. Run:
`bun packages/blam/bench/paired/harness.ts`.

## Control-plane adapter

A control plane under test implements:

    init(fixtureRepo): void
    dispatchLane(item): proc     # or scripted stand-in
    sweepCycle(): void           # the loop under test
    onScenarioEnd(): report

The v0 reference plane is `crash/plane.ts` (scripted, two eras —
`scenario.md` § eras). Suspenders is the reference control plane; its
pre-fix vs post-fix behavior on this suite is the first measured A/B:
post-fix passes 5/5 scenarios on every run; pre-fix reproduces the
2026-09-28 headline (S1 false retire, S4 debris/blame/data-loss, S5
foreign merge conclusion) and also fails S2 (heal deferred behind a
forged-alive marker) and S3 (act on a vanished branch name). Other
control planes adapt via the four functions.
