# W1799 — dangling-path report on `packages/suspenders/test/supervisor.ts` is a false positive

The item claimed merge 85576d93 dropped `packages/suspenders/test/supervisor.ts`
while `install-llm-steps.test.ts` still references it. Verification:

- `git log --all --oneline -- packages/suspenders/test/supervisor.ts` is empty —
  the path never existed on any branch, so the merge cannot have dropped it.
- The test's `"supervisor.ts"` hits are runtime string literals, not imports:
  `install-llm-steps.ts:601-602` resolves the seeded file via
  `deps.supervisorSource ?? join(beltBin(ctx), "supervisor.ts")`, i.e.
  `packages/belt/bin/supervisor.ts` (exists, 30 KB). The test asserts on the
  fake-home copy (`join(home, "supervisor.ts")`), never the repo path.
- Imports in the test file resolve (`../scripts/install-llm-steps.ts` etc.).
- Focused suite: `bun test packages/suspenders/test/install-llm-steps.test.ts`
  → 33 pass / 0 fail.

No repair needed; nothing restored or rewritten.
