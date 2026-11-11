# Repository-aware off-hours optimization

BLAM should learn which execution strategy finishes a repository's work
quickly and correctly. Historical fixes supply repeatable cases; model
calls run only after the case and evaluator have passed their controls.
The Sphinx experiments provide initial evidence, not a universal default.

## Case creation

1. Discover merged bug-fix PRs and linked issues through a GitHub adapter.
2. Pin the repository, failing base, fixed revision, environment and test
   commands. Reject ambiguous merge ancestry instead of guessing a base.
3. Expose the public problem and base-only source history to the candidate.
   Keep reference changes, evaluation tests and oracle storage outside it.
4. Run the same evaluator against the unmodified base and known fix.
   Require target failures on the base, passing targets on the fix, and
   preserved regression checks. Repeat controls to detect unstable tests.
5. Seal the eligible case with source, environment and evaluator hashes.
   Generated reproductions become candidates for this process, never
   evidence merely because a model says they are useful tests.

## Experiment contract

Use named Zod schemas for cases, strategies, attempt events, evidence and
recommendations. Reuse the paired executor/judge argv interface and the
official Pi Durable adapter. Judges cannot receive prompts; executors
cannot access withheld fixtures. Each attempt gets an isolated checkout,
stable identity, scoped route entitlement and cleanup receipt.

Record admitted, started, first meaningful source/test result, first
edit, child dispatch, join, terminal model result, judge and cleanup
separately. A successful version command is not a useful task result.
Missing usage, model identity or cleanup evidence makes a run ineligible.

## Search and selection

Rotate and counterbalance a declared strategy space: minimal context,
quoted base-revision lines, static analysis, directed workflows, fixed
verification tools, serial or batched inspections, effort settings, and
solo or parent-selected fanout. Context forks and cache reuse need their
own measured support; an identical prompt is not proof of shared state.
Unsupported settings are explicit outcomes, not silently substituted.

Optimize wall time per accepted patch, counting failed work and recovery.
Correctness and regression preservation are hard gates. Require at least
three fresh confirmations, then distinct held-out issues before creating
a recommendation. Preserve every later failure; a three-run streak does
not erase the rest of an arm's history. Compare token use after speed and
quality, with cached, fresh and reasoning usage recorded separately.

Store profiles by repository fingerprint, language/framework, problem
class, model route, runtime, toolset and environment revision. Record the
cases and receipts that justify each profile. Drift invalidates it.
Recommendations require explicit activation authority; experiments never
rewrite production routing or merge patches into their source project.

## Off-hours execution

Use a configured timezone and execution window with resumable intent and
append-only NDJSON receipts. Admit only explicitly allowed on-prem routes.
Use observed admission/health and the operator's CPU, concurrency and
capacity limits. Yield to interactive load, stop launching near the window
end, and release only resources owned by the campaign. Never take Fleet's
global controller lease or start a competing lane-refill process.

Near-zero token pricing does not remove GPU, energy or queue costs. Keep
those measurements and missing values explicit. Provider outages, invalid
harnesses, quality failures, cancellations and deadline-censored attempts
remain separate. No hidden cloud fallback or default turn/token ceiling.

## Delivery and dependencies

- W2981.1: reusable case, strategy, event and evidence contracts, plus
  eligibility checks and integration with existing executor receipts.
- W2981.2: GitHub history import, base-only materialization and controlled
  evaluation. Depends on W2981.1.
- W2981.3: off-hours campaign execution, ranking and scoped profile output.
  Depends on W2981.1; import integration also consumes W2981.2.
- W2971: official Pi Durable executor and parent-selected fanout evidence.
  Its synthetic controls complement pre-existing canonical issue cases.

Site deployment packaging lives in a private overlay repository. It pins
one Fleet source revision, publishes private GHCR images, and records the
required Fleet work IDs with immutable commits. Runtime keys remain in
host secret files or a secret store. A container smoke proves packaging;
GPU inference, private-network/APIM access and native microVM recovery
require independent acceptance receipts on their real deployment targets.
