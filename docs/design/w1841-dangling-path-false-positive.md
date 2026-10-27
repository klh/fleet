# W1841 — `packages/suspenders/test/cd.worktrees/W1357 && bun test product.test.ts` is a scanner false positive

## Finding

`packages/suspenders/test/cd.worktrees/W1357 && bun test product.test.ts`
never existed in git history: `git log --all` over both the minted form
(`packages/suspenders/test/cd.worktrees*`) and the spaced origin form
(`*cd .worktrees*`) is empty on every ref. The merge that produced
043636c6 deleted nothing — zero `D` entries — and is the commit that
ADDED the referencing file
`packages/suspenders/test/claim-check-copilot.test.ts`.

## Why the reference is not dangling

`claim-check-copilot.test.ts:54` holds
`"cd .worktrees/W1357 && bun test product.test.ts"` — one row of the
`test.each` list of direct test commands the Copilot claim-check parser
must recognize: a compound `cd <worktree> && bun test` invocation, the
same shape the lane contract itself produces when a lane runs its focused
suite from a worktree. It is a bash command fixture, not a path.

The W1302.2 scanner's `PATH_LIKE` heuristic matched because the literal
ends in `.ts`; the literal was then joined onto the containing directory
(`packages/suspenders/test/` + the command string) and the minted title
lost the space after `cd`, producing the phantom
`cd.worktrees/W1357 && bun test product.test.ts`. The W1302.2.1 scoping
(`FIXTURE_FILE`, hooks/lib/fleet-loop/dangling-paths.ts) now excludes
`*.test.ts` files from probe 2 entirely, so this class cannot re-mint.

Same class as W1806, W1815, W1818–W1823 and W1840 (same file, sibling
literal).

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is command fixture data feeding
`transcriptEventsFromText` / `claimCheckVerdict`, and rewriting it would
only trim the suite's coverage of compound-command recognition.

## Verification

- `git log --all -- "packages/suspenders/test/cd.worktrees*"` and
  `git log --all -- "*cd .worktrees*"` are both empty.
- `git diff --name-status 043636c6^1 043636c6` — zero `D` entries; the
  merge added the referencing file (`A`) and deleted nothing.
- Focused suite green:
  `bun test packages/suspenders/test/claim-check-copilot.test.ts` —
  numbers banked in the item's completion summary.
