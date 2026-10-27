# W1808 — dangling-path false positive: `packages/suspenders/test/flood-cause.ts`

Scanner item W1808 flagged `packages/suspenders/test/flood-cause.ts` as a
dangling path referenced by `packages/suspenders/test/install-llm-steps.test.ts`.

Disposition: **no repair needed** — false positive.

- The two hits (install-llm-steps.test.ts:757-758) are
  `tmp("w12052-flood-cause")` and `join(dir, "flood-cause.ts")` — a runtime
  fixture the test writes itself into its own tmpdir via `writeFileSync`
  before spawning it (`W1205.2: stdout flood keeps the stderr cause`).
- `flood-cause.ts` never existed as a repo file: `git log --all --follow`
  on the path is empty and merge 85576d93 deleted nothing by that name.
- No import of the basename exists anywhere under `packages/`.

Verification: `bun test packages/suspenders/test/install-llm-steps.test.ts`
= 33 pass / 0 fail.
