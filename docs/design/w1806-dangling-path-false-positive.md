# W1806 — `packages/suspenders/test/gen.ts` is a scanner false positive

## Finding

`packages/suspenders/test/gen.ts` never existed in git history
(`git log --all -- <path>` is empty on every ref; absent from both parents of
merge 85576d93). The merge dropped nothing.

## Why the reference is not dangling

`packages/suspenders/test/install-llm-steps.test.ts` mentions `"gen.ts"` in
exactly one place (line ~656):

```ts
const gen = join(dir, "gen.ts");
```

`dir` is a tmpdir fixture root, and the test itself writes the file two lines
later via `writeFileSync(gen, ...)` before executing it with `defaultRun`.
The literal names a runtime-created fixture inside a synthetic tree, not a
repo path — the same disposition as W1802 (`health.ts`, a seeded runtime-home
copy) and W1791/W1798.

Probe 2's W1302.2.1 scoping already excludes fixture files from
unresolvable-specifier judgment; this item came from the probe-1 whole-tree
grep, which keeps test files in scope and cannot see the `join(dir, ...)` /
`writeFileSync` pair.

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is fixture data.

## Verification

- `git log --all -- packages/suspenders/test/gen.ts` is empty.
- Import probe of `install-llm-steps.ts` resolves; focused
  `install-llm-steps` suite green (counts in the item close summary).
