# W1836 — `packages/suspenders/hooks/*` is a scanner false positive

## Finding

The item premise — "the merge that produced 043636c6 left
packages/suspenders/hooks/* missing" — is false. `git show 043636c6
--name-status` contains zero deletions; the only hooks path it touched is
`packages/suspenders/hooks/lib/fleet-loop/lane-launch.ts` (modified, not
deleted). The tree tracks 596 files under `packages/suspenders/hooks/` at
HEAD and 595 at 043636c6 (the +1 landed after the merge). The path never
went missing.

## Why the reference is not dangling

The reference is the exports mapping in
`packages/suspenders/package.json:42`:

```json
"./hooks/*": "./hooks/*",
```

The `*` is package-exports wildcard syntax, not a filesystem literal. The
W1302.2 dangling-path scanner resolves the string literally —
`resolveLiteral("./hooks/*", "packages/suspenders/package.json")` returns
`packages/suspenders/hooks/*` — and a literal path containing `*` never
exists on disk, so it mints a repair item. Same false-positive class as
W1828–W1834: the scanner heuristic misjudges a non-path literal.

## Disposition

False positive; no code change. There is no path to restore and no
reference to rewrite — the exports mapping is correct and live.

## Verification

- Every concrete specifier behind the wildcard resolves at runtime from a
  dependent package (`packages/blam`, after `bun install --force` healed
  the fresh worktree): `@klh/suspenders/hooks/gate.ts`,
  `hooks/bin/coord.ts`, `hooks/lib/govdb/govdb.ts` — all resolve into this
  worktree.
- Focused `source-closure` suite green: 7 pass / 0 fail at this tree.
