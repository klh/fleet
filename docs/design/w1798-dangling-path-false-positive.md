# W1798 — dangling-path report: false positive

The scanner item claimed `packages/suspenders/test/swarm.ts` was left dangling
by merge 85576d93. Disposition: no repair needed.

- `git log --all -- packages/suspenders/test/swarm.ts` is empty — the file
  never existed on any branch.
- The `"swarm.ts"` strings in `packages/suspenders/test/install-llm-steps.test.ts`
  are fixture paths inside a throwaway fake home
  (`join(home, "swarm.ts")`), not references to a repo file.
- Verified: imports resolve; focused suite
  `bun test packages/suspenders/test/install-llm-steps.test.ts` →
  33 pass / 0 fail (140 expect() calls).

2026-10-27, lane autow1798-p98b319584008df14.
