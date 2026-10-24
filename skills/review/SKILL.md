---
name: review
description: Use when asked to review branch changes, staged work, or recent commits before merge — five-axis structured review with file:line evidence and a machine-parseable verdict. Not for hunting bugs in one file (use find-bugs) or driving the fixes yourself.
---

For deep reviews, dispatch the code-reviewer persona (and security-auditor for security-critical changes). Mechanical pass first:

```bash
qlty check            # diff-aware: only your branch's changes
GIT_EXTERNAL_DIFF=difft git diff main...HEAD   # structural diff — moves/renames render correctly
```

Review the current changes (staged or recent commits) across all five axes:

1. **Correctness** — Does it match the spec? Edge cases handled? Tests adequate?
2. **Readability** — Clear names? Straightforward logic? Nowhere-else-documented behavior made explicit?
3. **Architecture** — Follows existing patterns? Clean boundaries? Right abstraction level? (Event mediator/composition over inheritance; close to the metal)
4. **Security** — Input validated? Secrets safe? Auth checked? (dispatch security-auditor for auth/crypto/input changes)
5. **Performance** — No N+1 queries? No unbounded ops? No unbounded buffering (streams over buffers)?

Categorize findings as Critical, Important, or Suggestion. Every finding carries `file:line` + the fix. Declare read-status (full/partial/blocked) per file you cite — a summary never outruns the evidence. Close with ONE machine-parseable final line: `VERDICT: PASS` or `VERDICT: FAIL - <reason>`.

## Gotchas

- A/B any test failure against the branch baseline before claiming it — the suspenders suite carries ~52 pre-existing fails; a flaky spec re-runs solo before triage.
- `bun test | tail` gates the chain on tail's exit 0 — the verifier runs bare or under `pipefail`.
- `git stash` is shared across worktrees on this mount — never bare `stash pop`; prefer a WIP commit.
- Read what you cite: full reads before review claims; a partial read is declared, not hidden.
- bun:sqlite `.get()` returns null on no match — an `!== undefined` guard is always true; flag it.
- Empty-string env knobs count as set (`env.X ?? fallback` passes on `""`) — flag untrimmed operator-knob fallbacks.
