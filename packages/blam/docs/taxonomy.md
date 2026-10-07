# The CRASH taxonomy

Five top-level failure classes for LLM agent fleets operating on shared
repositories. The letters spell how the fleet felt at the time.

- **C — Concurrency races**: two actors (agent, coordinator, human) interleave
  on shared mutable state and the interleaving wins over intent.
- **R — Recovery gaps**: a failure happened, and the recovery path itself was
  missing, silent, unsafe, or never actually loaded.
- **A — Alignment drift**: the system did technically-permitted but
  intent-wrong things — specs misread, defaults unsafe, effort misspent.
- **S — State poisoning**: one actor's mess becomes the next actor's
  starting condition.
- **H — Handoff failures**: work crosses a boundary (agent↔agent,
  run↔run, human↔agent) without the verification that boundary requires.

## Subclasses

### C — Concurrency races

| id | name | definition |
| --- | --- | --- |
| C1 | registry-lag | a branch/artifact exists before its registry entry; guards that read only the registry see nothing |
| C2 | liveness-forgery | a liveness check returns true for a dead or unrelated actor (pid reuse, stale marker, argv mismatch) |
| C3 | check-then-act | state changed between the check and the act (branch renamed/deleted mid-sweep) |
| C4 | double-writer | two actors mutate the same artifact without a lease |

### R — Recovery gaps

| id | name | definition |
| --- | --- | --- |
| R1 | debris-blocks-recovery | the recovery command itself fails on the failure's debris (staged paths block merge abort) |
| R2 | silent-failure | a step fails and its exit code/output is ignored; the loop continues green |
| R3 | unsafe-cleanup | cleanup deletes or prunes provable work (unguarded force-delete, aggressive gc) |
| R4 | fix-never-loaded | the fix exists on disk but the running system never loaded it (daemon not restarted) |
| R5 | misread-signal | an operator/agent misreads a buffered or quiet signal as a hang (or health) |

### A — Alignment drift

| id | name | definition |
| --- | --- | --- |
| A1 | spec-misread | the implemented behavior diverges from the mission text |
| A2 | sycophancy-cascade | reviewers inherit the worker's framing and agree |
| A3 | effort-misspend | unbounded spawning/retries on a task that did not warrant it |
| A4 | unsafe-default | a shipped default permits what the operator assumed was forbidden |

### S — State poisoning

| id | name | definition |
| --- | --- | --- |
| S1 | foreign-merge-conclusion | a bare commit concludes a merge it did not start |
| S2 | innocent-strike | debris from actor A's failure counts as actor B's failure |
| S3 | stale-path | a path/registry guess resolves to the wrong location; cleanup silently no-ops |
| S4 | gate-flakiness-park | a repairable quality issue escalates to a terminal state via strike accumulation |

### H — Handoff failures

| id | name | definition |
| --- | --- | --- |
| H1 | unverified-claim | a claim (signature, DONE sha, report) is trusted without verification |
| H2 | context-telephone | work passes through lossy re-summarization instead of artifacts |
| H3 | norm-without-enforcement | a convention coordinates until it matters, then fails |
| H4 | lost-final-line | the completion signal (sha/result) is never recorded where the system reads it |
| H5 | consult-never-asked | a question another actor could answer at near-zero cost is not asked; the asker re-derives it (duplicate investigation) or proceeds on a wrong assumption |
| H6 | answer-delivery-failure | a consult is attempted but the answer never reaches the asker's context (dead expert, full queue, relay drop, parser error, lost WS push) |
| H7 | unhelpful-answer | an answer arrives but carries no evidence, answer shape, or validity conditions, so the asker cannot apply or verify it |
| H8 | unverified-reuse | a cached answer or lesson is applied without provenance/version check; a stale answer silently becomes the asker's ground truth |

Communication failures (H5–H8) extend the MAST inter-agent axis with the
four observable points a consult can fail: failure to ask (H5), failure to
deliver (H6), failure to answer usefully (H7), failure to use the answer
correctly (H8). Duplicate investigation is the measured cost of H5, not a
class of its own.

## Annotator decision tree

Ask in order; first yes wins:

1. Did two actors interleave on shared state? → **C**
2. Did a failure recovery fail/miss/skip/never load? → **R**
3. Did the system do the permitted-but-wrong thing? → **A**
4. Did one actor's residue corrupt another actor's run? → **S**
5. Did work cross a boundary without required verification? → **H**

Ties: if C and S both feel true, C wins (poisoning requires the interleave);
if R and S both feel true, S wins (the debris IS the failure). Record the
runner-up in `notes` when genuinely contested.

## Provenance

Classes distilled from ~12 months of one-machine fleet operations (2025-09
through 2026-09), cross-checked against MAST's three-category taxonomy
(system-design / inter-agent misalignment / task-verification —
arXiv:2503.13657): MAST categories are orthogonal, not conflicting — a
CRASH incident often maps to a MAST category too; the mapping is recorded
per-record in the dataset. H5–H8 were added 2026-10-07 (W447) from the
consult evaluation research (toto-gpt.md, § "How to evaluate whether it
works") and the MAST ask/deliver/answer/use split.
