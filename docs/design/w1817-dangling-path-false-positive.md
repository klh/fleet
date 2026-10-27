# W1817 — `packages/suspenders/test/work.ts` is a scanner false positive

## Finding

`packages/suspenders/test/work.ts` never existed in git history
(`git log --all -- <path>` is empty on every ref). The merge that produced
c5d42437 dropped nothing.

## Why the reference is not dangling

`packages/suspenders/test/dispatch-reclaimed-context.test.ts` mentions
`"work.ts"` six times, always as the second argument to the harness helper
`toolA` (from `./helpers/dispatch-harness.ts`):

```ts
const take = await h.toolA({}, "work.ts", "take", id, "--as", sid);
```

`toolA` spawns `join(import.meta.dir, "..", "..", "hooks", "bin", bin)` —
i.e. the string resolves to `packages/suspenders/hooks/bin/work.ts`, which
exists on disk and in git. The literal is a bin filename joined to the
hooks bin dir at spawn time, never a repo path `packages/suspenders/test/`
+ `work.ts`. Same disposition as W1806 (`gen.ts` runtime fixture),
W1802 (`health.ts`), W1791/W1798, and sibling W1818
(`lane-context.json`, closed against this same test file).

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is a bin name for the harness spawner.

## Verification

- `git log --all -- packages/suspenders/test/work.ts` is empty.
- `packages/suspenders/hooks/bin/work.ts` exists.
- Focused `bun test dispatch-reclaimed-context.test.ts` run: failures are
  pre-existing on the untouched baseline (dispatch-harness work-add spawn
  noise, shared with the sibling W1818 A/B on this same file) — no
  test-affecting file changed on this branch.
