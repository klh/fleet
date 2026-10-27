# W1802 — dangling-path finding is a false positive

## Finding

`packages/suspenders/test/health.ts` never existed in this repo's
history — `git log --all -- packages/suspenders/test/health.ts` is
empty on every branch. Merge 85576d93 dropped nothing.

The occurrences of `"health.ts"` in
`packages/suspenders/test/install-llm-steps.test.ts` (lines 187, 350,
354, 377, 380, 391) are bare runtime-home FILENAMES, not import paths:
line 187 lists `health.ts` among the files the install step seeds into
`~/.claude/local-llm`, and lines 350/377/391 build `join(home,
"new-health.ts")` / `join(home, "health.ts")` fixtures. The real source
the seeder copies from is
`join(beltBin(ctx), "health.ts")`
(`packages/suspenders/scripts/install-llm-steps.ts:614`) →
`packages/belt/bin/health.ts`, which exists (present since a8bd4a12).

## Verification

- `bun test packages/suspenders/test/install-llm-steps.test.ts` →
  33 pass / 0 fail
- `packages/belt/bin/health.ts` present; imports resolve.

## Disposition

No code change needed; the dangling-path item is closed as a false
positive with this note as the product commit.
