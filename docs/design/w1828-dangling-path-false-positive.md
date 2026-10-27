# W1828 — dangling-path premise false: `packages/suspenders/test/operator-link.json`

Disposition receipt (no-op). Same class as W1806/W1820/W1821/W1823–W1827: the
fleet-loop `code.dangling-path` scanner resolved the bare filename specifier
`"operator-link.json"` against the referencing test's own directory and
flagged it as a missing repo path.

## Premise check

- The only reference is
  `packages/suspenders/test/work-completion-claim-context.test.ts:338`:
  `const linked = join(f.home, "operator-link.json")` — a symlink fixture
  created at runtime inside the harness's temp home (`f.home`), then passed
  as an argument to the `work` CLI. It is never a repo path; nothing reads
  `packages/suspenders/test/operator-link.json`.
- `git log --all --oneline -- packages/suspenders/test/operator-link.json`
  returns empty: no such file ever existed in any ref, so merge `c5d42437`
  cannot have dropped it.
- Runtime corroboration: the focused suite passes with no dangling read.

## Verification

- `bun install --force` (fresh-worktree link heal; initial run failed 12/12
  in `test/helpers/work-completion-fixtures.ts:49` on stale package links —
  environmental, not item-related).
- Focused suite:
  `cd packages/suspenders && bun test test/work-completion-claim-context.test.ts`
  → **12 pass / 0 fail, 201 expect() calls**.
- Import check: the test's imports (`join`, `symlinkSync`, fixture module)
  resolve; the flagged specifier is a runtime-constructed path, not an
  import.

## Disposition

Mission-sanctioned option 3: supersede with the reason (no-op receipt).
No restore needed — the path never existed; no rewrite needed — the
reference is correct as-is. Recurring class fix (scanner should skip bare
filenames the test itself constructs at runtime) remains the follow-up
candidate noted by W1820–W1827 reviews.
