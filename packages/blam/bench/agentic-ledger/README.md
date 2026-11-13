# Ledger fixture: paired agentic coding benchmark (second held-out task)

The fixture is a small TypeScript ledger library with three independent
broken modules in a reconciliation failure-class domain — balance
reconciliation (refund sign, inclusive cutoff), journal sequence integrity
(deduplication, range bounds, ordering), and retry-safe posting (replay
window boundary, eviction order). Its failure classes are deliberately
distinct from the relay fixture's claim/cache/trace domain; nothing was
copied from it. These are synthetic examples. The source and exact hidden
checks were created for this benchmark, not taken from a public coding
benchmark.

`fixture/` is the only material given to evaluated agents. `oracle.ts` and
`reference/` remain outside the fixture repository. The oracle has 24
deterministic checks (8 per module) and emits
`{score,passed,total,failures}`. Controls, reproducible on a clean
checkout: broken fixture 9/24 (score 0.375); reference 24/24 (score 1.0).
The score is the fraction of checks passed, not an independent expert
assessment of real Fleet code quality.

Hygiene law (same as bench/agentic/README.md):

1. `fixture/` is the ONLY material evaluated agents receive; `oracle.ts`
   and `reference/` stay outside the fixture repo.
2. Oracle = deterministic checks outside the fixture; controls documented
   here before any scored attempt.
3. NO private-judge leakage: no private check names, no reference fixes,
   no scored-attempt knowledge in `fixture/README.md` or `fixture/src/`;
   the judge never receives `{prompt}` (live.md manifest law).
4. Neutral ids only in committed code (scrub law).
5. Manifest contract per `../paired/live.md` (executor argv
   `{worktree}`/`{model}`, judge argv `{worktree}`).

## Reproduce

1. Connect AC power. Pin one model and use one fixture commit for both arms.
2. Run `bun packages/blam/bench/agentic-ledger/prepare.ts /tmp/ledger-fixture`
   to make a disposable Git repository. The command refuses an existing
   target.
3. Create a local manifest following `../paired/live.md`: `repo` points to
   the disposable fixture, `judge` to this directory's `oracle.ts`, and
   `executor` is the pinned agent command with
   `["...","--worktree","{worktree}","--model","{model}","{prompt}"]`
   placeholders.
4. Both harness texts contain an explicit `Mode: solo`, `Mode: review`, or
   `Mode: split` line. Keep the task text, model, executor argv, judge, and
   fixture base commit fixed within each paired comparison.
5. Run `bun packages/blam/bench/paired/live.ts /tmp/ledger-manifest.json`.
   Keep its private patches and report outside the repository; curate a
   short measurement row in fleet-root `benchmarks.md`.

## Measurement row template

```markdown
| date | model | fixture commit | mode | arm | score (passed/24) | wall s | tokens in/out | cache read/write | notes |
| ---- | ----- | -------------- | ---- | --- | ----------------- | ------ | ------------- | ---------------- | ----- |
| 2026-11-12 | <pinned-model> | <base sha> | solo | baseline | /24 | | | | |
| 2026-11-12 | <pinned-model> | <base sha> | solo | candidate | /24 | | | | |
| 2026-11-12 | <pinned-model> | <base sha> | review | candidate | /24 | | | | agent count 2 |
```

Compare each treatment with its matched solo arm. Record total reported
tokens, cache-read and cache-write tokens, wall time, agent count, and
oracle score for every arm. A null cache field means the executor did not
provide that metric; it is not a measured zero. The single-fixture sample
size makes quality results smoke tests under the fleet-root sample-size
rule; do not promote a global harness policy from this fixture alone.
