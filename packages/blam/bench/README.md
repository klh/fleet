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

SPEC ONLY — no S1-S5 harness or scenario directory exists yet; the table
above is the specification. The suites that run today are the two below.
Each future scenario lands as `scenario.md` (fixture, injection, window,
properties) + `harness.ts` (deterministic driver).

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

## Live paired harness experiment (W919)

`paired/live.ts` runs one coding task under two harness texts. Every arm
starts from the same Git commit in a disposable worktree. The executor argv,
model, task, and timeout are identical; only the appended harness guidance
changes. Runs alternate arm order across repetitions. A separate validation
command, held outside both worktrees, scores the resulting artifact. The
runner records exit status, measured executor tokens and wall time, validation
status, and a patch for each arm in a local output directory. Missing usage,
timeouts, failed execution, failed candidate validation, fewer than three
pairs, or a weak paired lift all refuse promotion. The runner reports a
decision; it does not change any installed harness or global policy.

Run: `bun packages/blam/bench/paired/live.ts /path/to/manifest.json`.
The manifest schema and a Codex example are in `paired/live.md`. A
credentialless integration test exercises the same runner with an agent
stand-in; those token numbers are test data, not a model benchmark.

## Synthetic agentic coding fixture (W922)

`agentic/` holds an unpublished, deterministic repair task drawn from three
Fleet failure classes: claim release after agent restart, honest cache
accounting, and W3C trace propagation. The model sees only the broken fixture
and its contract. A separate oracle scores 22 behavior checks, including
boundary cases omitted from the visible contract. The checked-in reference
scores 22/22; the broken starting point scores 7/22. `strategy.ts` can run
one agent, a second reviewer, or three isolated module owners. Paired live
runs compare harness guidance from the same fixture revision and report
model tokens, cache reads and writes when emitted, elapsed time, oracle score,
and agent count. The results and limits belong in the fleet-root
[`benchmarks.md`](../../../benchmarks.md). See
[`agentic/README.md`](agentic/README.md) for the exact protocol.

## What runs today — commands, runtime, limits

    bun packages/blam/bench/consult/harness.ts    # 3 policies × 2 KB states × 2 delivery modes, ~10ms
    bun packages/blam/bench/paired/harness.ts     # 5 cases × 2 arms × 4 reps, paired per rep, ~20ms
    bun packages/blam/test/agentic-oracle.test.ts # fixture and oracle controls

The two deterministic suites end with `6/6 properties hold` (`scenario.md` in each directory
defines them) and are fully deterministic — outcomes are computed from
scripted scenario models, so numbers reproduce byte-for-byte. They
measure policy/protocol mechanics, not live model behavior.

Scope boundary: BLAM's deterministic suites score control-plane coordination
robustness (failure reproduction, detection, recovery). The agentic fixture
also measures coding output under specified harness treatments. It does not
rank general model quality; Belt's model-fleet measurements live in the
fleet-root `benchmarks.md`.

## Control-plane adapter

A control plane under test implements:

    init(fixtureRepo): void
    dispatchLane(item): proc     # or scripted stand-in
    sweepCycle(): void           # the loop under test
    onScenarioEnd(): report

Suspenders is the intended reference control plane. The pre-fix vs
post-fix A/B (pre-fix: S1/S4/S5 fail; post-fix: pass — from the
2026-09-28 incident record) is the expected first result once S1-S5
harnesses exist; it has not been measured by any runnable suite yet.
Other control planes adapt via the four functions.
