# W1823 — `packages/suspenders/test/unrelated.txt` is a scanner false positive

## Finding

`packages/suspenders/test/unrelated.txt` never existed in git history
(`git log --all -- <path>` is empty on every ref). The merge that produced
c5d42437 dropped nothing by that name.

## Why the reference is not dangling

`packages/suspenders/test/dispatch-reclaimed-context.test.ts` names
`"unrelated.txt"` in exactly one place (lines 146–161), twice:

```ts
writeFileSync(join(tree, "unrelated.txt"), "never adopt unrelated residue\n");
// ...
expect(readFileSync(join(tree, "unrelated.txt"), "utf8")).toBe(
	"never adopt unrelated residue\n",
);
```

`tree` is the test's own scratch worktree fixture (`join(h.REPO,
".worktrees", id)` for a harness-minted item id); the test writes the file
at line 146 before reading it at line 161. The literal names a
runtime-created fixture inside a synthetic tree, not a repo path — the same
disposition as W1806 (`gen.ts`), W1802, W1791/W1798, and W1821.

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is fixture data.

## Verification

- `git log --all -- packages/suspenders/test/unrelated.txt` is empty.
- Focused `dispatch-reclaimed-context` suite green (3 pass / 0 fail after
  `bun install` healed the fresh worktree's dependency links).
