# W1804 — dangling-path finding dispositioned false positive

Finding: `packages/suspenders/test/remotes.json` reported missing while
`packages/suspenders/test/install-llm-steps.test.ts` ("remotes.json")
references it (merge `85576d93`).

## Why it is false

- The path never existed: `git log --all -- packages/suspenders/test/remotes.json`
  is empty, and `--diff-filter=D` over all refs shows no deletion. The merge
  deleted nothing by that name.
- The only `remotes.json` literals in the test are fixture HOME writes —
  `writeFileSync(join(home, "remotes.json"), …)` at :428 and :532 — runtime
  tmpdir data the test creates itself before the generator reads it, never a
  reference into the repo tree.
- No file in the repo references the repo path: `rg -F 'test/remotes.json'
  packages/` returns nothing.
- The scanner's probe-1 whole-tree grep cannot see the `join` + write pair
  (probe-2's W1302.2.1 fixture-file scoping already excludes test files), so
  the basename-form hit resolved onto the never-real path.

## Evidence

- import probe of `install-llm-steps.ts` resolves
- `bun test install-llm-steps.test.ts` = 33 pass / 0 fail
- pre-push verb suite: 188 pass / 0 fail
- scrub clean; branch pushed (`suspenders/W1804` @ d0bb0003)

Disposition: superseded with reason, no repair.
