# Relay fixture: paired agentic coding benchmark

The fixture is a small TypeScript repository with three independent broken
modules. Its contracts reproduce failure classes observed in Fleet work:
claim release must identify the claimant instance, cache telemetry must
distinguish unsupported from zero and expose writes, and trace forwarding must
preserve a valid W3C `traceparent`. These are synthetic examples. The source
and exact hidden checks were created for this benchmark, not copied from a
public coding benchmark.

`fixture/` is the only material given to evaluated agents. `oracle.ts` and
`reference/` remain outside the fixture repository. The oracle has 22
deterministic checks and emits `{score,passed,total,failures}`. Controls:
broken fixture 7/22; reference 22/22. The score is the fraction of checks
passed, not an independent expert assessment of real Fleet code quality.

## Reproduce

1. Connect AC power. Pin one model and use one fixture commit for both arms.
2. Run `bun packages/blam/bench/agentic/prepare.ts /tmp/relay-fixture` to
   make a disposable Git repository. The command refuses an existing target.
3. Create a local manifest following `../paired/live.md`: `repo` points to
   the disposable fixture, `judge` to this directory's `oracle.ts`, and
   `executor` is
   `["bun","<absolute path>/strategy.ts","--worktree","{worktree}","--model","{model}","--prompt","{prompt}"]`.
4. Both harness texts contain an explicit `Mode: solo`, `Mode: review`, or
   `Mode: split` line. Keep the task text, model, executor argv, judge, and
   fixture base commit fixed within each paired comparison.
5. Run `bun packages/blam/bench/paired/live.ts /tmp/relay-manifest.json`.
   Keep its private patches and report outside the repository; curate a
   short measurement row in fleet-root `benchmarks.md`.

The strategy runs Codex in an ephemeral session. Solo uses one agent. Review
adds a fresh agent after implementation. Split runs three agents in separate
Git worktrees, each restricted to one module, then applies their patches to
the judged arm. This measures the cost of actual extra agent calls and their
output. It does not assume that three agents are cheaper than one.

Compare each treatment with its matched solo arm. Record total reported
tokens, cache-read and cache-write tokens, wall time, agent count, and oracle
score for every arm. A null cache field means the executor did not provide
that metric; it is not a measured zero. Provider cache reads measure token
accounting, while warm session or reused reasoning state requires separate
evidence. The small number of distinct tasks makes quality results smoke
tests under the fleet-root sample-size rule. Do not promote a global harness
policy from this fixture alone.
