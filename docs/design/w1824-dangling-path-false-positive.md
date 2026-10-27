# W1824 — `packages/suspenders/test/original.ts` is a scanner false positive

## Finding

`packages/suspenders/test/original.ts` never existed in git history
(`git log --all -- <path>` is empty on every ref). The merge that produced
c5d42437 dropped nothing.

## Why the reference is not dangling

`packages/suspenders/test/dispatch-reclaimed-context.test.ts` mentions
`"original.ts"` only inside its fixture: line ~197 writes
`writeFileSync(join(tree, "original.ts"), "export const original = true;\n")`
into a synthetic tree the test creates, and lines 198/216 then reference that
runtime-created file. The literal names a fixture inside a test-created tmp
tree, not a repo path — the same disposition as W1806 (`gen.ts`), W1826
(`operator-stop.json`) and W1827 (`operator-reconcile.json`).

The dangling-path scanner came from the whole-tree grep, which keeps test
files in scope and cannot see the `join(tree, ...)` / `writeFileSync` pair.

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is fixture data.

## Verification

- `git log --all -- packages/suspenders/test/original.ts` is empty.
- Focused `dispatch-reclaimed-context` suite green (3 pass / 0 fail) at the
  closing sha, after healing the fresh worktree with `bun install`
  (missing `@vercel/detect-agent`).
