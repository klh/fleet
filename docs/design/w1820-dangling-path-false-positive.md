# W1820 — dangling-path report is a false positive

Probe source flagged `packages/suspenders/test/README.md` as missing while
`packages/suspenders/test/dispatch-reclaimed-context.test.ts` references
`"README.md"`.

## Why it is false

Both `"README.md"` references (lines 44 and 71) are
`join(tree, "README.md")` where `tree = join(h.REPO, ".worktrees", id)`
(test/dispatch-reclaimed-context.test.ts:24) — a runtime temp-fixture tree
the test creates, writes via `writeFileSync`, and reads back. `README.md` is
fixture state, never a repo path. No `packages/suspenders/test/README.md`
ever existed and none is required.

## Verification

`bun test packages/suspenders/test/dispatch-reclaimed-context.test.ts`
= 3 pass / 0 fail (35 expect calls), after `bun install --force` healed the
fresh worktree's dependency links (first run's 3 fails were link rot, not
product code).
