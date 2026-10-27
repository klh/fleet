# W1797 — dangling-path finding is a false positive

## Finding

`packages/suspenders/scripts/health.ts` never existed in this repo's
history — `git log --all -- packages/suspenders/scripts/health.ts` is
empty on every branch. Merge 85576d93 dropped nothing.

The reference in `packages/suspenders/scripts/install-llm-steps.ts:614`
is `join(beltBin(ctx), "health.ts")` where `beltBin(ctx)` resolves to
`packages/belt/bin` — and `packages/belt/bin/health.ts` exists (present
since a8bd4a12). No repo file references a `scripts/health.ts` path
(repo-wide `rg "scripts/health\.ts"` = zero hits).

## Verification

- `bun -e 'await import("<repo>/packages/belt/bin/health.ts")'` → exit 0
- `bun -e 'await import("packages/suspenders/scripts/install-llm-steps.ts")'` → 9 exports
- `bun test packages/suspenders/test/install-llm-steps.test.ts` → 33 pass / 0 fail

## Disposition

No code change needed; the dangling-path item is closed as a false
positive with this note as the product commit.
