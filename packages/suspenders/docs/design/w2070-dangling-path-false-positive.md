# W2070 — dangling-path premise false: `scripts/hooks/bin/coord.ts` never existed

## Finding

The item claimed merge 6fd2b5a8 dropped
`packages/suspenders/scripts/hooks/bin/coord.ts` while
`packages/suspenders/scripts/sync-harness.ts:41` (`"hooks/bin/coord.ts"`, in
`ENTRYPOINTS`) still referenced it. Verified at HEAD:

- `git cat-file -e 6fd2b5a8:packages/suspenders/scripts/hooks/bin/coord.ts`
  → fatal: path does not exist; `git log --all -- packages/suspenders/scripts/hooks`
  → empty. The directory never existed in any tree.
- The reference is package-root-relative, not `scripts/`-relative: `ENTRYPOINTS`
  entries are consumed as `join(suspenders, relative)` (sync-harness.ts `validate`)
  and `packages/suspenders/${entry}` (`CLOSURE_ENTRIES`). The target
  `packages/suspenders/hooks/bin/coord.ts` is tracked and present, and its
  entrypoint bundles clean.

## Focused tests

- Real validator: `sourcePaths()` (payloadClosure over `CLOSURE_ENTRIES`,
  refuses on vanished faces) ran clean against the worktree — 27 closure
  paths, zero missing; `Bun.build` of `hooks/bin/coord.ts` → OK (after
  `bun install` for `@vercel/detect-agent`).
- `bun test test/sync-harness.test.ts`: 34 pass / 2 fail — both fails are the
  W1468 kit-twin spawner tests, pre-existing environmental on HEAD (reported
  identically by sibling W2067); the delta here is docs-only.

## Disposition

No code change. Item closed as false positive — same scanner class as
W2061 / W2063 / W2067 (detector resolves string literals against the
referencing file's directory); source fix tracked as W2172/W2173.
