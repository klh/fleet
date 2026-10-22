# How to review in the fleet

Adapted from Anthropic's "Solving code review at Anthropic" (claude.dev, 2026-10-15),
re-cut for this repo: most fleet code is lane-produced, so review here is mostly
reviewing agent output.

Review has two jobs: catch issues before they land, and spread understanding of the
codebase. "Did a human read the code?" is a proxy for the real question: **what could
go wrong with this change, and which check — automated or human — is the right one to
catch it?** Review is not a gate at the end of the road; it runs continuously, and a
change should already have been reviewed by machinery at least once before a human
looks at it.

## Principles

- **Evidence before claims.** "Tests pass" is prose until the command and its real
  output are shown. A review finding is a lead until it has a file and line.
- **LLM output is leads, not facts.** Applies symmetrically: to the code the lane
  wrote AND to the findings a reviewing model reports. Neither is trusted on
  assertion; both are verified against the tree.
- **Human attention is the scarce resource.** Optimize for the minimum human review
  time that does not raise reverts or incidents. Time saved on reading but spent
  fixing bad merges is not saved.
- **Layers, not one gate.** Self-review, automated checks, machine review, security
  review, human approval. Each layer catches some problems and misses others; fast
  revert catches the rest.
- **Review must converge.** An agent author and an agent reviewer can keep each other
  busy forever. Cap rounds; after the first few, re-review only the new diff; flag
  the class of bug, not one instance; never repeat a posted finding.
- **Fix repeated findings at the source.** If the same comment shows up three times,
  the fix is an AGENTS.md line, a biome rule, or a gate — not a fourth comment.

## What to review (risk tiers)

The change sets the tier, not the author. Blast radius sets the bar.

| Tier | Fleet examples | Required review |
| --- | --- | --- |
| Low | Docs, markdown, copy, additive changes behind a flag | Automated checks green; no human approval |
| Medium | Ordinary package changes (new verbs, UI components, tests) | One reviewer — the person who prompted the lane counts |
| High | Gates + hooks (they enforce law), buckle auth chain (keys, scopes, minting), scrub gate + denylist, `install.sh` + launchd plists, hubctl/compose, config-over-code surfaces, CI/law-guard tests, health probes | Two people; agent review never fills a human slot |

Fleet-specific high-risk tells: anything that could leak a host, key, or user path
(scrub gate exists for a reason); anything that changes how lanes are spawned,
keyed, or priced; anything weakening a gate. A change that edits the referee gets
the strictest review.

## How to review agent-produced code

1. **Verify the verification.** Ask what ran, not whether it passed. Real command,
   real output, on the changed files. Parse-pass is not intent-pass: corruption in
   this repo has landed syntax-valid (a stray `--flag,` in an array, garbled paths,
   a dangling `--sha`). Read the emitted diff, not just the build status.
2. **Fresh-context machine review.** `oracle review` / `oracle bugs` / `oracle
   analyze` on the diff — the named stateless reviewer, never ad-hoc "please review"
   phrasing. It reads the diff against the whole repo and the mission's stated
   intent: does the change solve its problem, fit the system, break something else?
3. **Check the laws the change touches.** 1500-line limit, config-over-code (no
   hardcoded hosts/keys), shell scripts banned, Lit UI law (no `innerHTML`), streams
   over buffers, install-grade-only changes. The reviewer flags code that breaks a
   convention AND changes that make an instruction line out of date.
4. **Every finding gets answered.** Fix it, or resolve the thread with a short
   reason (that is how a false positive clears). Findings are tagged **Important**,
   **Nit**, or **Pre-existing** so a bug the change didn't introduce doesn't read as
   the author's fault — the baseline A/B worktree is the pre-existing evidence.
5. **Flag the class.** "This pattern recurs at lines 40/97/210" fixes every
   instance; "change line 40" buys another round.
6. **Own the outcome.** Whoever prompted the lane is on the hook for the change —
   you land it, you own it. An agent's approval never counts as a person's.

## Reviewer checklists

Author/lane, before requesting review:

- Build/tests run against the real tree; output captured, not summarized.
- `qlty fmt` + `qlty check` on the changed files; formatter drift not hand-chased.
- `git diff` re-read for emission drift (string literals, argument lists, anchors).
- Laws check: the ones the change touches, no more.
- Commit subject starts with the item id; capsule banked; work item updated.

Reviewer, on any change:

- Intent: does it do what the mission says, only that, and nothing hidden in the diff?
- Evidence: what verification exists, and what would these checks miss?
- Blast radius: what imports this, which gates/tests guard it, what ships with it?
- Secrets/scrub: no real hosts, keys, user paths, corporate names.
- The verdict final line exists and is machine-parseable (below).
- Convergence: is this a new finding, or a repeat? Repeats go to the source fix.

Security-sensitive adds: key material and scopes, denylist edits, loopback/Host
guards, write tokens, mint/revoke paths. On these, style nits are dropped and one
open Important finding blocks the merge.

## Verdict vocabulary

Report-shaped output ends with ONE machine-parseable final line. Parents regex the
final line, not the prose — never paraphrase it.

| Report shape | Final line |
| --- | --- |
| Review | `VERDICT: PASS` · `VERDICT: FAIL - <reason>` |
| Critique | `APPROVED` · `NEEDS REVISION - <reason>` |
| Gap analysis | `CLEAR` · `GAPS_FOUND - <detail>` · `INSUFFICIENT_CONTEXT` |

Consuming rule: PASS/APPROVED/CLEAR proceeds; FAIL/NEEDS REVISION/GAPS_FOUND fails
fast (fix or `coord consult`) and is never reinterpreted as a pass. An empty verdict
is a fail.

## Where humans stay in the loop

- **Should we build this at all** — direction, taste, scope. Agents make starting
  cheap; some work should not land. Raise it in the thread early, not as a blocking
  comment on a finished change.
- **Risky code** — gates, auth, launchd, installers, the scrub surface.
- **Architecture** that sets a pattern other lanes will copy.
- **Reading the evidence** — if you cannot say what the checks would miss, ask for a
  real review, not a quick approval.
- **Owning the outcome** — a person is accountable for everything that lands.

Nobody holds the whole codebase in their head; for understanding, ask for an
explainer of exactly the slice you are about to change. That beats line-reading a
trivial diff.

## Harness integration

### Implemented machine-review and landing receipts (W1130)

The existing second-opinion runner loads applicable root/package `AGENTS.md`
and `REVIEW.md` from the immutable candidate merge tree. Its `work.review`
receipt binds the full candidate commit, integration base, instruction hashes,
independent registered reviewer session, verdict, blocking IDs and evidence.
An explicit `RESOLVED: B1-id <evidence>` line resolves a prior finding on the
same commit; a later empty PASS cannot erase it.

The canonical Fleet merge ladder defers missing, stale or blocked receipts,
and rechecks immediately before publication. Changing the candidate, moving
the integration base or changing applicable instructions requires fresh review.
Unreviewed branches remain available; missing review does not consume the
three-strike parking budget. `work done` remains branch completion, not landing.
The separate idempotent `work.landed` event is written only after the exact
DONE commit is verified as an ancestor of the integration checkout's HEAD.

These are machine-review receipts. Session registration is Fleet's existing
local coordination identity boundary, not cryptographic proof of a human or
organizational independence. The risk-tier human requirements above remain
an operator obligation; no trusted human-approval connector exists here, and
the machine receipt must not be presented as satisfying those requirements.

The proposals below remain unimplemented unless stated otherwise.

### a. What the harness could add to support the practice

- **Oracle review profiles.** Per-package review briefs (a REVIEW.md analog) that
  `oracle review` loads: what failure looks like in that package (docs: "it lies";
  gates: "it stops enforcing"; config: "it misroutes"), capped nits, skip paths,
  evidence = file:line, summary starts with a count and says plainly when clean.
- **Lane-brief review checklists.** Dispatch composes the author-side checklist into
  every brief, so self-review happens before `work done`, not after.
- **Dispatch-gate review steps.** A pre-close gate step that runs `oracle review` on
  the lane diff for medium/high tiers and records the verdict on the item; a
  security-review pass for auth/gate/scrub paths.
- **Board review surfaces.** The fleet board renders verdicts, open findings, and
  rounds-to-pass per item, so convergence (and non-convergence) is visible.
- **Incidents as evals.** Reverted/failed lanes become a scored eval set; any change
  to review prompts, oracle routing, or gates is rescored against it — same spirit
  as tests/law-guards.test.ts.

### b. How to use reviews for better outcomes

- **Verdicts into the work graph.** `work done` summaries carry the final verdict
  line; the board aggregates pass rate and rounds-to-pass as fleet health signals,
  with revert/incident rate as the guardrail metric.
- **Review-gated merges.** Integration merges require a PASS verdict on the lane
  branch; high-tier paths require a second human approval; approval is pinned to the
  exact sha (already true: `work done --sha`) and re-required when new commits land.
- **Classifier triage.** The kev (:8912) / fit-classifier leg scores findings —
  severity + class — drops style/diagnostics-only findings, routes Important to the
  human, batches Nits to the author lane, and tags Pre-existing from the baseline
  A/B. Noise control matters double here: an agent author fixes every nit, which
  means another round.
