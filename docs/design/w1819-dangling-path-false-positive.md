# W1819 — dangling-path report disposition: `continuation.txt` (false positive)

The dangling-path scanner flagged
`packages/suspenders/test/continuation.txt` as referenced-but-missing from
`packages/suspenders/test/dispatch-reclaimed-context.test.ts`. The premise
is false — same class as the W1806 finding (`gen.ts`, a runtime tmp
fixture).

## Why the path is not a repo path

The test builds its own scratch repo and writes the file as a fixture
before asserting on it:

- `writeFileSync(join(tree, "continuation.txt"), "preserve this untracked
  product\n")` — `tree` is `join(h.REPO, ".worktrees", id)` for a
  scratch-repo item id minted inside the test, so the write lands in the
  test's own scratch worktree, not in the fleet repo.
- The only other reference is the read-back assertion at the end of the
  same test. `git log --all -- packages/suspenders/test/continuation.txt`
  has no history: the path was never tracked.

## Disposition

No code change. An empty disposition commit (`8bd04893`) lands on
`suspenders/W1819` so the no-op close carries evidence, and the focused
suite `test/dispatch-reclaimed-context.test.ts` ran green after a fresh
`bun install` (3 pass, 35 expect() calls) — the harness's `work add`
spawn needs the workspace `@vercel/detect-agent` link present.

Scanner rule improvement so this class stops firing: a reference is only
dangling when the quoted path is a plausible repo path AND the referencing
file does not also construct/write that basename at runtime. The W1806 and
W1819 reports both cite names the test writes via `writeFileSync` before
reading.
