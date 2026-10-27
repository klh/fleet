# W1835 — dangling-path premise false: `scripts/build-vendor.ts` exists and runs

## Finding

The item claimed merge 043636c6 dropped
`packages/suspenders/scripts/build-vendor.ts` while
`packages/suspenders/package.json:14` (`"build:vendor": "bun scripts/build-vendor.ts"`)
still referenced it. Verified at main `031770c3`:

- `git cat-file -e main:packages/suspenders/scripts/build-vendor.ts` → exists
  (lineage: `8179c5e7` W1107.2.2 → `deb67750` W1158 → `1f9ced37` W1159).
- `bun packages/suspenders/scripts/build-vendor.ts --help` bundles 32 modules
  clean — the reference resolves and imports fine.

## Focused tests

`bun test test/vendor-chunk-names.test.ts test/vendor-hash.test.ts` in the
worktree: 5 pass / 2 fail (vendor-hash byte-drift + shared-runtime assertion).
A/B rig at main (detached worktree, identical command): the SAME 2 fail / 5
pass — pre-existing on main, unrelated to the dangling-path premise. No repair
belongs to this item.

## Disposition

No code change. Item closed as false positive, same class as W1806 /
W1824-W1828.
