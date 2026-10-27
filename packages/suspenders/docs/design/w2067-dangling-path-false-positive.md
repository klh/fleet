# W2067 — dangling-path false positive: `scripts/hooks/session-start.ts`

## Verdict

False positive. `packages/suspenders/scripts/hooks/` never existed in any
tree (git history empty for the path), and nothing references it. The
dangling-path scanner mis-attributed the reference in
`packages/suspenders/scripts/sync-harness.ts` — its
`"hooks/session-start.ts"` string is repo-relative to
`packages/suspenders/`, not to `scripts/`, and resolves to the real
`packages/suspenders/hooks/session-start.ts`, which is tracked and present.

## Evidence

- `git ls-tree HEAD -- packages/suspenders/hooks/session-start.ts` → blob
  `b26e9252` (present).
- `git cat-file -e 6fd2b5a8^{tree}:packages/suspenders/scripts/hooks` →
  `fatal: path … does not exist` — the merge the item blames left nothing
  behind; the path never existed.
- The same string is also in `ENTRYPOINTS` (sync-harness.ts:38) and
  `HOOK_ITEMS` (hooks/lib/harness-manifest.ts:20) — both resolve through
  the same relative base.
- Live validator: `sourcePaths()` from sync-harness.ts (which walks
  `payloadClosure` and refuses on any vanished face) ran clean against this
  worktree at HEAD — 27 closure roots, zero `missing`.

## Disposition

Nothing to restore or rewrite; superseded as a no-op disposition per this
doc. Sibling dispositions of the same scanner class: W2061, W2063
(`docs/design/w206{1,3}-dangling-path-false-positive.md`).
