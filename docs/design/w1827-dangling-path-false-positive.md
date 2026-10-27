# W1827 — dangling path `packages/suspenders/test/operator-reconcile.json`: false positive

## Finding

`packages/suspenders/test/operator-reconcile.json` never existed as a repo
path (`git log --all` on every ref is empty for it). The two references in
`packages/suspenders/test/work-completion-claim-context.test.ts` are to a
runtime-written fixture file inside the test's isolated temp `HOME`
(`join(f.home, "operator-reconcile.json")`, test line 307; written via
`writeFileSync(evidencePath, …)` at :335/:347, mode-pinned at :337). No
repair, rewrite, or restore is needed — the test is self-contained by
design.

## Verification

- `bun test packages/suspenders/test/work-completion-claim-context.test.ts`
  → 12 pass / 0 fail (after `bun install` healed the fresh worktree's
  `@vercel/detect-agent` link — the initial 12 fails were that missing
  module, not the referenced path).
- Only other occurrence of the name repo-wide is this doc.
