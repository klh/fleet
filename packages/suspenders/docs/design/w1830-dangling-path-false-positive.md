# W1830 — dangling-path false positive: `scripts/scripts/dispatch-next.ts`

**Disposition: no-op. The mission's premise is false.**

## The flagged reference

`packages/suspenders/scripts/ensure-shims.ts:38`:

```ts
? join(prefix, "scripts/dispatch-next.ts")
```

## Why the path is not dangling

`shimTarget()` resolves the bare specifier `"scripts/dispatch-next.ts"`
against `prefix` — the harness/installed prefix (`state/harness` in the
tests, the sync-harness publication root in the install), i.e. the
*package root* equivalent, whose `scripts/` dir holds `dispatch-next.ts`
(`packages/suspenders/scripts/dispatch-next.ts`, present on disk and in
git). `scripts/scripts/dispatch-next.ts` was never a repo path: the
dangling-path scanner heuristic-joined the bare specifier against the
*referencing file's own directory* (`scripts/`), inventing the doubled
segment. `git log --all -- packages/suspenders/scripts/scripts/dispatch-next.ts`
is empty.

## Verification

- Focused suite `packages/suspenders/test/ensure-shims.test.ts`: **5 pass,
  0 fail** — its fixture writes `join(c.prefix, "scripts/dispatch-next.ts")`
  and asserts the dispatch shim targets exactly that path, so the real
  resolution is runtime-proven.
- `git log --all` on the phantom path: empty (never existed).

## Class

Same `code.dangling-path` scanner false-positive class as W1806, W1802,
W1791/W1798, W1821, W1823–W1827: heuristic joins of bare specifiers against
the referencing file's directory. The class wants a source fix in the
scanner (resolve specifiers against the prefix/root the file itself uses),
not per-instance repo edits.
