# W1837 — dangling path `packages/suspenders/scripts/*`: false positive

## Finding

`packages/suspenders/scripts/` exists (62 files) and every path
`packages/suspenders/package.json` references resolves on branch head:
the `./scripts/*` exports entry, the `files` entry, and all three script
executables (`scripts/build-vendor.ts`, `scripts/dispatch-next.ts`) plus
every `hooks/bin/*` bin target. The merge 043636c6 (W1731) deleted no
script file — its scripts/ delta was two edits (`ensure-shims.ts` shim
list, `install-llm-steps.ts` Z.ai snapshot preflight removal) whose
imports were updated in the same merge.

## Why the item looked real

Same class as W1825: a fresh worktree lacked `@vercel/detect-agent` (added
to dependencies by 043636c6). After `bun install --force` the dependency
resolves via the package-local symlink and the focused suites run: 50 pass
/ 0 fail across `package-contract`, `install-llm-steps`, `ensure-shims`,
`install-llm-drain` (the `cli-e2e-matrix-doors` hubctl doors fails are
pre-existing — a detached A/B at the merge-base 031770c3 reproduces them,
6 fail there vs 3 here, unrelated to scripts/*).

## Disposition

No repair, no rewrite: the reference is correct as written. This document
is the tracked disposition record (the close commit carries it); branch
`suspenders/W1837`, commit head at close.
