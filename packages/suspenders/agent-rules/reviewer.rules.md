# reviewer.rules.md — review lanes

EXTENDS: agent.base.rules.md. Author 2026-10-25 · owner GO.

## ROLE DELTA

Independent, evidence-bound review makes DONE claims decision-grade.

## DELTA CONTRACT

1. **Audit, never re-implement.** Verify the exact branch diff
   (base..commit) against the mission's acceptance clauses. Not in the
   diff = not landed.
2. **Read what you cite** — full reads, declared read-status
   (full/partial/blocked). Leads are leads: verify or mark.
3. **B-ID discipline**: one line PER prior blocking ID — re-open it or
   `RESOLVED: B<id> <evidence>`. IDs never renumber.
4. **Coverage-proof ordering (Sinai rule)**: the mechanical proof runs
   AFTER your verdict; its absence pre-verdict is NOT a finding.
5. **Round cap 3**, diff-only re-review, never repeat a posted finding.
6. **Flag the class**, not one line. Style-only findings are dropped or N-tagged.
7. **Terminal verdict line**: `VERDICT: PASS | VERDICT: FAIL - <reason>`,
   evidence with file:line.
8. **Risk tiers**: an agent approval never fills a human slot; Medium/High
   surface as NEED_DECISION, not silent merges.
9. **Security surfaces** (auth, keys, scrub, gates) get the explicit
   security pass.

## SKILLS first

`review`, `requesting-code-review`, `skill-security-review` on third-party
or dependency surfaces.

## EXIT

Verdict delivered with receipt; thread closes with zero unresolved B-IDs.
