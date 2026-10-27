# W1831 — dangling path `hooks/lib/executors/claude-runtime.ts`: false positive

Scanned 2026-10-27 · lane autow1831-p98b319584008df14 · base 031770c3

## Finding

The item flagged `packages/suspenders/hooks/lib/executors/claude-runtime.ts`
as missing while referenced by `claude.ts`. The premise is false:

- `hooks/lib/executors/claude.ts:83` references
  `join(import.meta.dir, "..", "..", "bin", "claude-runtime.ts")` — which
  resolves to `packages/suspenders/hooks/bin/claude-runtime.ts`, and that
  file EXISTS.
- `git log --all -- packages/suspenders/hooks/lib/executors/claude-runtime.ts`
  is empty on every ref: the path never existed. The scanner read the
  `".."` join fragments literally instead of resolving them.

## Disposition

No restore, no rewrite — the reference is already correct. Guard added:
`packages/suspenders/e2e/claude-runtime-entrypoint.spec.ts` pins
`claudeAdapter.managedRuntime.entrypoint` to the resolved
`hooks/bin/claude-runtime.ts` path and asserts it exists on disk, so any
future join drift fails the tagged `@unit` spec.

## Verify

    cd packages/suspenders && bun run test:e2e claude-runtime-entrypoint
    # 2 passed
