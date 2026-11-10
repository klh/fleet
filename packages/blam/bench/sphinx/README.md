# Sphinx orchestration benchmark replay

The task is SWE-bench Verified instance sphinx-doc__sphinx-9461, base
939c7bb7ff7c53a4d27df067cea637540f0e1dad. Use the official problem
statement as the brief. Keep all reference and evaluation material
outside the agent repository.

## Current replay

Use `completion-first-provider-limit.ts`. The other Pi drivers
are historical artifacts. Their results document failure modes and should
be excluded from runner rankings. Earlier runs differed in compaction
headroom and output limits, and could spend time rediscovering tools or
attempting downloads in an offline sandbox.

Build with `bun build --target bun --packages external`. Resolve
`@klh/suspenders` and `@klh/buckle` from the Fleet checkout and use
`@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and
`@earendil-works/chord` at version 1.5.0. Run with the following arguments:

    bun <compiled driver> <fresh absolute standalone clone> <brief> <pretask> <serial|parallel|smoke> [absolute patch output]

Use fresh detached clones at the stated base for live runs. The sandbox
runs offline as UID 1000 with read-only Git metadata, bounded command
execution, and clipped tool output. The smoke mode checks discovery and
the sandbox without a model request. Keep both arms on the same route,
image, pretask and resource limits. Run them one at a time and record
order, queue time, model stream time, compaction, tool time and cache
usage separately. The driver omits the client output cap on the wire.
The provider default remains unverified.

There is no model-turn or aggregate command-count ceiling. The run
deadline is 20 minutes, with per-command timeouts and output limits.
A deadline exit is a censored observation. Use `BLAM_PI_THINKING=off`,
`low` (default), or `medium` to vary effort independently. The settings
receipt hashes the brief and pretask and the wire receipt records the
actual thinking mode and effort. Reject comparisons when the requested
treatment did not reach the provider.

For a static-analysis treatment, run Qlty metrics without plugins on a
separate pristine clone of the pinned base. Give the model a bounded
list of function names and metrics in the pretask. Record Qlty version,
runtime, analyzed paths, and the pretask hash. Do not run host analysis
against the candidate checkout or include results from the private judge.
Keep effort, brief and tool mode fixed when comparing this treatment
with the original pretask.

For grading, point `SWE_ORACLE_DIR` at the private directory containing
the original SWE-bench instance record and its generated `eval.sh`.
Run `grade.sh <exported patch> <unique label>`. It applies the patch in
the digest-pinned evaluator container. The agent checkout is never passed
to the grader. Keep private evaluator assets outside the replay checkout.

For a separate context-injection pair, fix one inspection mode. Append
short code ranges verified with `git show` at the pinned base in the
treatment only. Keep private evaluator assets out of both prompts.

## Discovery-first delegation receipts

W2971 compares a thinking-enabled parent that implements solo with the
same parent profile allowed to choose and delegate implementation after
discovery. Record the parent's chosen scopes and briefs. Cap child
workers at the route's verified low effort and record both the requested
and wire settings. Use the same aggregate budget and private evaluator.

Join Fleet receipts by child run ID. Record intent creation, first
durable submit, first successful guest tool, terminal child result and
parent join as separate events. A durable submit witnesses that start
was triggered. A successful guest tool witnesses useful work. Keep the
child's patch and usage separate from parent integration and review.
Count missing receipts as missing evidence, and report an intentional
solo decision as a distinct outcome.
