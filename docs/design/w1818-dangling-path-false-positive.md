# W1818 — dangling-path false positive: `packages/suspenders/test/lane-context.json`

## Claim (from the item)

The merge c5d42437 left `packages/suspenders/test/lane-context.json` missing
while `packages/suspenders/test/dispatch-reclaimed-context.test.ts` still
references it.

## Finding: the premise is false

The test never references a repo path. Every occurrence builds the path at
runtime:

```ts
const tree = join(h.REPO, ".worktrees", id);            // lines 24, 145, 184
join(tree, ".fleet", "lane-context.json")               // lines 30, 75, 123, 128, 218
```

That resolves to `.worktrees/<id>/.fleet/lane-context.json` — the per-lane
claim context the work CLI writes into a registered worktree at take time,
read back by the test through its harness. It is a runtime-written fixture
path, not a file that ever existed in the repo:

```
git log -- packages/suspenders/test/lane-context.json   → empty (no commits)
```

Nothing to restore, no reference to rewrite.

## Verification

`bun test packages/suspenders/test/dispatch-reclaimed-context.test.ts` runs
the three cases against the live harness; the failures observed on this
branch are in `work add` id extraction at the harness spawn
(`dispatch-harness.ts:234`), pre-existing on the unmodified baseline (this
lane landed zero code changes) and unrelated to the claimed missing file —
none of the failures mention `lane-context.json`.

Precedent: W1806 (same detector, same disposition — a runtime-written tmp
fixture misread as a repo path).
